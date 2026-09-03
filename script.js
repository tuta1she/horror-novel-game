/* =========================================================================
   script.js
   -------------------------------------------------------------------------
   Движок визуальной новеллы. Ничего не знает о конкретном сюжете —
   весь контент приходит из data.js (INITIAL_STATE, SCENES).

   Основные части:
     1. Хранилище состояния (state) + сохранение/загрузка в localStorage.
     2. Рендер сцены: фон, окружение, последовательность реплик (с эффектом
        печатной машинки), затем — головоломка ИЛИ варианты выбора.
     3. Применение эффектов (effects) сцен, реплик и выборов к state.
     4. Обработчики UI (меню, кнопка "Далее", кнопки выбора, головоломки,
        рестарт).

   -------------------------------------------------------------------------
   ФОРМАТ СЦЕНЫ (см. подробные комментарии в data.js):
     - Сцена может задавать ОДНУ реплику через поля `speaker` + `text`,
       ЛИБО массив реплик через поле `dialogue: [{speaker, text, effects}]`.
       Второй вариант позволяет нескольким персонажам говорить по очереди
       в рамках одной сцены — каждая реплика печатается отдельно, игрок
       листает их кнопкой "Далее".
     - После того как показаны все реплики сцены, движок показывает:
         а) головоломку (scene.puzzle), если она задана, ИЛИ
         б) варианты выбора (scene.choices), если головоломки нет.
       Если ни того, ни другого нет — считается, что это финальная сцена
       (глава окончена), и показывается экран "Начать заново".
   ========================================================================= */

(function () {
  "use strict";

  /* ------------------------------------------------------------------
     КОНСТАНТЫ
     ------------------------------------------------------------------ */
  const SAVE_KEY = "vn_horror_detective_save_v1"; // ключ в localStorage
  const SAVE_VERSION = 2; // увеличивать при несовместимых изменениях формата state
  const TYPE_SPEED_MS = 22; // задержка между символами в эффекте печатной машинки

  /* ------------------------------------------------------------------
     ССЫЛКИ НА DOM-ЭЛЕМЕНТЫ (кешируем один раз при загрузке)
     ------------------------------------------------------------------ */
  const el = {
    bgLayer: document.getElementById("bg-layer"),
    bgSvgLayer: document.getElementById("bg-svg-layer"),
    gameRoot: document.getElementById("game-root"),
    flashOverlay: document.getElementById("flash-overlay"),
    mainMenu: document.getElementById("main-menu"),
    gameScreen: document.getElementById("game-screen"),
    endScreen: document.getElementById("end-screen"),
    endScreenKicker: document.getElementById("end-screen-kicker"),
    endScreenTitle: document.getElementById("end-screen-title"),
    endScreenSubtitle: document.getElementById("end-screen-subtitle"),
    endScreenText: document.getElementById("end-screen-text"),

    btnNewGame: document.getElementById("btn-new-game"),
    btnContinue: document.getElementById("btn-continue"),
    btnEraseSave: document.getElementById("btn-erase-save"),
    saveInfo: document.getElementById("save-info"),
    btnRestart: document.getElementById("btn-restart"),
    btnRestartEnd: document.getElementById("btn-restart-end"),
    btnNext: document.getElementById("btn-next"),
    btnSoundToggle: document.getElementById("btn-sound-toggle"),

    sanityBar: document.getElementById("sanity-bar"),
    suspicionBar: document.getElementById("suspicion-bar"),

    btnCluesToggle: document.getElementById("btn-clues-toggle"),
    btnCluesClose: document.getElementById("btn-clues-close"),
    cluesPanel: document.getElementById("clues-panel"),
    cluesList: document.getElementById("clues-list"),
    cluesCount: document.getElementById("clues-count"),

    environmentBox: document.getElementById("environment-box"),
    speakerName: document.getElementById("speaker-name"),
    dialogueText: document.getElementById("dialogue-text"),
    choicesBox: document.getElementById("choices-box"),

    puzzleBox: document.getElementById("puzzle-box"),
    puzzlePrompt: document.getElementById("puzzle-prompt"),
    puzzleHint: document.getElementById("puzzle-hint"),
    puzzleInput: document.getElementById("puzzle-input"),
    puzzleFeedback: document.getElementById("puzzle-feedback"),
    btnPuzzleSubmit: document.getElementById("btn-puzzle-submit")
  };

  /* ------------------------------------------------------------------
     ГЛОБАЛЬНОЕ СОСТОЯНИЕ ИГРЫ (в оперативной памяти)
     Инициализируется копией INITIAL_STATE из data.js, чтобы не мутировать
     сам constant при игре.
     ------------------------------------------------------------------ */
  let state = deepClone(INITIAL_STATE);

  // Флаг: идёт ли сейчас анимация печатной машинки (чтобы не запускать
  // вторую поверх первой при быстром клике).
  let isTyping = false;
  let typingTimeoutId = null;

  // Текущая последовательность реплик активной сцены и индекс той,
  // что показывается сейчас. Заполняется в renderScene().
  let currentLines = [];
  let currentLineIndex = 0;

  // Головоломка, которая сейчас активна (или null). Используется
  // обработчиком кнопки "Проверить" / клавиши Enter в поле ввода.
  let currentPuzzle = null;

  /* ------------------------------------------------------------------
     УТИЛИТЫ
     ------------------------------------------------------------------ */

  function deepClone(obj) {
    // Простое глубокое клонирование через JSON — достаточно для наших
    // данных (числа/строки/массивы/объекты без функций и циклов).
    return JSON.parse(JSON.stringify(obj));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Нормализация ответа игрока для головоломок: убираем лишние пробелы
  // по краям, схлопываем внутренние пробелы, приводим к нижнему регистру.
  // Так "  Ядовито " и "ядовито" засчитываются как одинаковый ответ.
  function normalizeAnswer(str) {
    return String(str || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  /* ------------------------------------------------------------------
     СОХРАНЕНИЕ / ЗАГРУЗКА (localStorage)
     -------------------------------------------------------------------
     Формат в хранилище: { __v: SAVE_VERSION, state: {...} }. Версия
     позволяет безопасно отличить сохранение от более старой/несовместимой
     редакции игры (например, после того как в state.flags добавили новые
     поля) и не пытаться загрузить заведомо битые данные — вместо падения
     игра просто откатится к новой партии.
     ------------------------------------------------------------------ */

  function saveGame() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ __v: SAVE_VERSION, state: state }));
    } catch (e) {
      console.warn("Не удалось сохранить игру:", e);
    }
  }

  // Проверяет, что загруженный объект действительно похож на валидное
  // состояние игры (все ключевые поля на месте и currentSceneId существует
  // в текущем SCENES) — иначе повреждённое или устаревшее сохранение могло
  // бы уронить игру на следующем renderScene().
  function isValidState(candidate) {
    return !!candidate &&
      typeof candidate.sanity === "number" &&
      typeof candidate.suspicion === "number" &&
      Array.isArray(candidate.clues) &&
      candidate.flags && typeof candidate.flags === "object" &&
      typeof candidate.currentSceneId === "string" &&
      !!SCENES[candidate.currentSceneId];
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.__v !== SAVE_VERSION) {
        console.warn("Сохранение устаревшего формата — начинаем новую игру.");
        return null;
      }
      if (!isValidState(parsed.state)) {
        console.warn("Сохранение повреждено — начинаем новую игру.");
        return null;
      }
      return parsed.state;
    } catch (e) {
      console.warn("Не удалось прочитать сохранение:", e);
      return null;
    }
  }

  function clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (e) { /* игнорируем */ }
  }

  /* ------------------------------------------------------------------
     ПРИМЕНЕНИЕ ЭФФЕКТОВ
     effects может встречаться в сцене (при входе), в отдельной реплике
     (при показе конкретной строки диалога) и в выборе (в момент клика) —
     используем одну и ту же функцию во всех случаях.
     ------------------------------------------------------------------ */
  function applyEffects(effects) {
    if (!effects) return;

    if (typeof effects.sanity === "number") {
      state.sanity = clamp(state.sanity + effects.sanity, 0, 100);
    }
    if (typeof effects.suspicion === "number") {
      state.suspicion = clamp(state.suspicion + effects.suspicion, 0, 100);
    }
    if (effects.addClue && !state.clues.includes(effects.addClue)) {
      state.clues.push(effects.addClue);
    }
    if (effects.setFlag) {
      Object.keys(effects.setFlag).forEach((flagName) => {
        state.flags[flagName] = effects.setFlag[flagName];
      });
    }
    if (effects.sound) {
      // Реальный синтез звука — см. audio.js (Web Audio API, без файлов).
      // Если GameAudio почему-то недоступен, тихо пропускаем — игра не падает.
      if (window.GameAudio) {
        window.GameAudio.playEffect(effects.sound);
      }
    }

    /* -----------------------------------------------------------------
       "ЖУТКИЕ" ЭФФЕКТЫ — внезапные визуальные/тактильные скачки для
       нагнетания паранойи. Все три ниже — необязательные поля effects:

         vibrate:    number | number[] — паттерн вибрации в миллисекундах,
                     передаётся в navigator.vibrate(). Работает только на
                     устройствах/браузерах с поддержкой Vibration API
                     (обычно мобильные); на остальных тихо игнорируется.
         glitch:     true — короткая "цифровая рябь" всего игрового окна
                     (сдвиг + смещение цвета на ~350мс).
         flashColor: CSS-цвет ("#6e1414" и т.п.) — резкая вспышка на весь
                     экран, тут же гаснущая. По умолчанию тёмно-красный.
       ----------------------------------------------------------------- */
    if (effects.vibrate && navigator.vibrate) {
      try { navigator.vibrate(effects.vibrate); } catch (e) { /* игнорируем */ }
    }
    if (effects.glitch) {
      triggerGlitch();
    }
    if (effects.flashColor) {
      triggerFlash(effects.flashColor);
    }

    renderHud(); // эффекты могли поменять sanity/suspicion — обновим полоски сразу
  }

  function triggerGlitch() {
    el.gameRoot.classList.remove("glitching");
    // Форсируем reflow, чтобы анимация могла перезапуститься, даже если
    // glitch произошёл только что (например, два эффекта подряд).
    void el.gameRoot.offsetWidth;
    el.gameRoot.classList.add("glitching");
    setTimeout(() => el.gameRoot.classList.remove("glitching"), 380);
  }

  function triggerFlash(color) {
    el.flashOverlay.style.background = color;
    el.flashOverlay.classList.add("flash-active");
    setTimeout(() => el.flashOverlay.classList.remove("flash-active"), 160);
  }

  /* ------------------------------------------------------------------
     ОТРИСОВКА HUD (полоски рассудка/подозрения + счётчик улик)
     ------------------------------------------------------------------ */
  function renderHud() {
    el.sanityBar.style.width = state.sanity + "%";
    el.suspicionBar.style.width = state.suspicion + "%";
    el.sanityBar.classList.toggle("low", state.sanity <= 25);

    // Цвет полоски рассудка плавно едет от болотно-зелёного (высокий
    // sanity) к кроваво-красному (низкий) через HSL: зелёный ~ hue 100,
    // красный ~ hue 0. Промежуточные значения дают жёлто-оранжевые тона.
    const hue = Math.round((state.sanity / 100) * 100); // 0..100
    el.sanityBar.style.backgroundColor = "hsl(" + hue + ", 55%, 42%)";

    if (el.cluesCount) {
      el.cluesCount.textContent = String(state.clues.length);
    }
  }

  /* ------------------------------------------------------------------
     ПАНЕЛЬ УЛИК
     -------------------------------------------------------------------
     Показывает человекочитаемые названия/описания собранных улик из
     CLUE_DESCRIPTIONS (data.js). Если для какого-то id улики описания
     нет (не должно случаться, но на всякий случай) — просто выводим сырой
     id, чтобы список не "терял" находку молча.
     ------------------------------------------------------------------ */
  function renderClues() {
    el.cluesList.innerHTML = "";

    if (state.clues.length === 0) {
      const li = document.createElement("li");
      li.className = "clue-empty";
      li.textContent = "Пока ничего не найдено.";
      el.cluesList.appendChild(li);
      return;
    }

    state.clues.forEach((clueId) => {
      const info = (window.CLUE_DESCRIPTIONS && window.CLUE_DESCRIPTIONS[clueId]) || null;
      const li = document.createElement("li");

      const titleEl = document.createElement("span");
      titleEl.className = "clue-title";
      titleEl.textContent = info ? info.title : clueId;
      li.appendChild(titleEl);

      if (info && info.description) {
        const descEl = document.createElement("span");
        descEl.className = "clue-description";
        descEl.textContent = info.description;
        li.appendChild(descEl);
      }

      el.cluesList.appendChild(li);
    });
  }

  function toggleCluesPanel(forceState) {
    const shouldShow = forceState !== undefined ? forceState : el.cluesPanel.classList.contains("hidden");
    if (shouldShow) {
      renderClues();
      el.cluesPanel.classList.remove("hidden");
    } else {
      el.cluesPanel.classList.add("hidden");
    }
  }

  /* ------------------------------------------------------------------
     ОТРИСОВКА ФОНА СЦЕНЫ
     -------------------------------------------------------------------
     Три параллельных эффекта на каждую смену локации:
       1. CSS-класс bg-* — цветовая "заливка" настроения (см. style.css).
       2. SVG-силуэт локации из backgrounds.js — вставляется как разметка
          внутрь #bg-svg-layer поверх заливки.
       3. Фоновый эмбиент (GameAudio.setAmbient) — гул/ветер/скрипы,
          подобранные под конкретную локацию (см. audio.js).
     ------------------------------------------------------------------ */
  function applyBackground(backgroundKey) {
    const key = backgroundKey || "default";

    el.bgLayer.className = "";
    el.bgLayer.classList.add("bg-" + key);
    el.bgLayer.classList.add("bg-default"); // фоллбэк-градиент под любой фон

    if (el.bgSvgLayer) {
      const svgMarkup = (window.BACKGROUND_SVGS && (window.BACKGROUND_SVGS[key] || window.BACKGROUND_SVGS.default)) || "";
      el.bgSvgLayer.innerHTML = svgMarkup;
    }

    if (window.GameAudio) {
      window.GameAudio.setAmbient(key);
    }
  }

  /* ------------------------------------------------------------------
     ЭФФЕКТ ПЕЧАТНОЙ МАШИНКИ
     ------------------------------------------------------------------ */
  function typeText(text, onDone) {
    el.dialogueText.textContent = "";
    el.dialogueText.classList.add("typing");
    el.btnNext.classList.add("hidden");
    isTyping = true;

    let i = 0;
    function step() {
      if (!isTyping) return;
      if (i < text.length) {
        el.dialogueText.textContent += text[i];
        i++;
        typingTimeoutId = setTimeout(step, TYPE_SPEED_MS);
      } else {
        finishTyping();
      }
    }

    function finishTyping() {
      isTyping = false;
      el.dialogueText.textContent = text;
      el.dialogueText.classList.remove("typing");
      el.btnNext.classList.remove("hidden");
      if (onDone) onDone();
    }

    el.dialogueText._skip = finishTyping;
    step();
  }

  function skipTyping() {
    if (isTyping) {
      clearTimeout(typingTimeoutId);
      if (el.dialogueText._skip) el.dialogueText._skip();
    }
  }

  /* ------------------------------------------------------------------
     ОТРИСОВКА ОДНОЙ РЕПЛИКИ ИЗ currentLines[currentLineIndex]
     ------------------------------------------------------------------ */
  function renderCurrentLine() {
    const line = currentLines[currentLineIndex];

    if (line.speaker) {
      el.speakerName.textContent = line.speaker;
      el.speakerName.classList.remove("hidden");
    } else {
      el.speakerName.classList.add("hidden");
    }

    // У отдельной реплики тоже может быть свой effects (например,
    // тревожный звук именно в момент этой фразы) — применяем при показе.
    applyEffects(line.effects);

    typeText(line.text);
  }

  /* ------------------------------------------------------------------
     ОТРИСОВКА ВАРИАНТОВ ВЫБОРА
     ------------------------------------------------------------------ */
  function renderChoices(choices) {
    el.choicesBox.innerHTML = "";

    if (!choices || choices.length === 0) {
      showEndScreen();
      return;
    }

    el.choicesBox.classList.remove("hidden");

    choices.slice(0, 4).forEach((choice) => {
      const isAvailable = !choice.condition || choice.condition(state);
      if (!isAvailable && !choice.showLocked) {
        return;
      }

      const btn = document.createElement("button");
      btn.className = "choice-btn" + (!isAvailable ? " locked" : "");
      btn.textContent = choice.text + (!isAvailable ? "  🔒" : "");
      btn.disabled = !isAvailable;

      if (isAvailable) {
        btn.addEventListener("click", () => onChoiceSelected(choice));
      }

      el.choicesBox.appendChild(btn);
    });
  }

  function onChoiceSelected(choice) {
    applyEffects(choice.effects);
    state.currentSceneId = choice.next;
    renderScene(state.currentSceneId); // сам сохранит игру в конце — см. renderScene()
  }

  /* ------------------------------------------------------------------
     ГОЛОВОЛОМКИ (ввод текста)
     -------------------------------------------------------------------
     scene.puzzle = {
       prompt:       строка-задание, показывается над полем ввода
       hint:         (необязательно) короткая подсказка, показывается
                      всегда дим-текстом под prompt
       answers:      массив допустимых ответов (регистр и лишние пробелы
                      не важны — сравнение идёт через normalizeAnswer)
       successNext:  id сцены при верном ответе
       successEffects: (необязательно) effects, применяемые при успехе
       failText:     текст, показываемый при неверном ответе
       failEffects:  (необязательно) effects, применяемые при КАЖДОЙ
                      неверной попытке (например, небольшая потеря sanity —
                      "нервотрёпка" от невозможности решить головоломку)
     }
     ------------------------------------------------------------------ */
  function renderPuzzle(puzzle) {
    currentPuzzle = puzzle;

    el.puzzlePrompt.textContent = puzzle.prompt;

    if (puzzle.hint) {
      el.puzzleHint.textContent = "Подсказка: " + puzzle.hint;
      el.puzzleHint.classList.remove("hidden");
    } else {
      el.puzzleHint.classList.add("hidden");
    }

    el.puzzleInput.value = "";
    el.puzzleFeedback.textContent = "";
    el.puzzleFeedback.classList.add("hidden");
    el.puzzleFeedback.classList.remove("success");

    el.puzzleBox.classList.remove("hidden");
    el.puzzleInput.focus();
  }

  function submitPuzzleAnswer() {
    if (!currentPuzzle) return;

    const given = normalizeAnswer(el.puzzleInput.value);
    const accepted = currentPuzzle.answers.map(normalizeAnswer);

    if (given.length > 0 && accepted.includes(given)) {
      // Верный ответ
      el.puzzleFeedback.textContent = "Верно.";
      el.puzzleFeedback.classList.remove("hidden");
      el.puzzleFeedback.classList.add("success");
      applyEffects(currentPuzzle.successEffects);

      const nextId = currentPuzzle.successNext;
      currentPuzzle = null;
      // Небольшая пауза, чтобы игрок увидел "Верно." перед переходом.
      setTimeout(() => {
        el.puzzleBox.classList.add("hidden");
        state.currentSceneId = nextId;
        renderScene(nextId); // сам сохранит игру в конце — см. renderScene()
      }, 450);
    } else {
      // Неверный ответ — остаёмся в головоломке, даём попробовать снова
      applyEffects(currentPuzzle.failEffects);
      el.puzzleFeedback.textContent = currentPuzzle.failText || "Неверно. Попробуйте ещё раз.";
      el.puzzleFeedback.classList.remove("hidden", "success");
      el.puzzleInput.value = "";
      el.puzzleInput.focus();
    }
  }

  /* ------------------------------------------------------------------
     ОТРИСОВКА СЦЕНЫ ЦЕЛИКОМ
     ------------------------------------------------------------------ */
  function renderScene(sceneId) {
    const scene = SCENES[sceneId];
    if (!scene) {
      console.error("Сцена не найдена:", sceneId);
      el.dialogueText.textContent =
        "[Ошибка движка: сцена \"" + sceneId + "\" отсутствует в data.js]";
      el.choicesBox.classList.add("hidden");
      el.puzzleBox.classList.add("hidden");
      return;
    }

    // Эффекты "при входе" в сцену целиком (не путать с effects отдельных
    // реплик в scene.dialogue) — применяются один раз до показа текста.
    applyEffects(scene.effects);

    // Фон
    applyBackground(scene.background);

    // Окружение (текстовая декорация)
    if (scene.environment) {
      el.environmentBox.textContent = scene.environment;
      el.environmentBox.classList.remove("hidden");
    } else {
      el.environmentBox.classList.add("hidden");
    }

    // Скрываем варианты выбора и головоломку — появятся только после
    // того, как будут показаны все реплики сцены.
    el.choicesBox.classList.add("hidden");
    el.choicesBox.innerHTML = "";
    el.puzzleBox.classList.add("hidden");
    currentPuzzle = null;

    // Формируем список реплик: если задан scene.dialogue — используем
    // его как есть (несколько говорящих подряд); иначе оборачиваем
    // одиночные scene.speaker/scene.text в массив из одного элемента —
    // так весь остальной код работает одинаково в обоих случаях.
    if (scene.dialogue && scene.dialogue.length > 0) {
      currentLines = scene.dialogue;
    } else {
      currentLines = [{ speaker: scene.speaker || null, text: scene.text || "" }];
    }
    currentLineIndex = 0;

    renderCurrentLine();

    // Сохраняем ПОСЛЕ того, как все эффекты входа в сцену (в том числе
    // effects первой реплики, применяемые внутри renderCurrentLine())
    // уже наложены на state — так сохранённая партия всегда точно
    // соответствует тому, что в этот момент видно на экране, и при
    // обновлении страницы игрок не потеряет и не задвоит прогресс.
    saveGame();
  }

  /* ------------------------------------------------------------------
     ЭКРАН ФИНАЛА ГЛАВЫ / GAME OVER
     -------------------------------------------------------------------
     Текст и цветовая схема экрана зависят от того, какая именно из 6
     концовок была достигнута — см. ENDING_META в data.js (ключ по
     scene id: scene_ending_truth / _partial / _wrongful / _madness /
     _solo / _fragile). Если по какой-то причине для текущей финальной
     сцены метаданных нет (устаревшие данные и т.п.) — используется
     нейтральный фоллбэк, чтобы экран всё равно не остался пустым.
     ------------------------------------------------------------------ */
  function showEndScreen() {
    el.gameScreen.classList.add("hidden");
    el.endScreen.classList.remove("hidden");

    const finalSceneId = state.currentSceneId;
    const meta = (window.ENDING_META && window.ENDING_META[finalSceneId]) || {
      kind: "neutral", title: "Конец главы", subtitle: ""
    };

    el.endScreen.classList.remove("ending-good", "ending-neutral", "ending-bad");
    el.endScreen.classList.add("ending-" + (meta.kind || "neutral"));

    el.endScreenKicker.textContent = meta.kind === "good" ? "ИСТОРИЯ ЗАВЕРШЕНА" : "КОНЕЦ ИГРЫ";
    el.endScreenTitle.textContent = meta.title || "Конец главы";
    el.endScreenSubtitle.textContent = meta.subtitle || "";

    el.endScreenText.textContent =
      "Собрано улик: " + state.clues.length +
      ". Рассудок: " + state.sanity +
      ". Подозрение: " + state.suspicion + ".";

    if (window.GameAudio) {
      window.GameAudio.setAmbient(meta.kind === "bad" ? "night" : "default");
    }
  }

  /* ------------------------------------------------------------------
     ПЕРЕКЛЮЧЕНИЕ ЭКРАНОВ (меню / игра)
     ------------------------------------------------------------------ */
  function showScreen(name) {
    el.mainMenu.classList.add("hidden");
    el.gameScreen.classList.add("hidden");
    el.endScreen.classList.add("hidden");

    if (name === "menu") el.mainMenu.classList.remove("hidden");
    if (name === "game") el.gameScreen.classList.remove("hidden");
    if (name === "end") el.endScreen.classList.remove("hidden");
  }

  /* ------------------------------------------------------------------
     СТАРТ НОВОЙ ИГРЫ / ПРОДОЛЖЕНИЕ / РЕСТАРТ
     ------------------------------------------------------------------ */
  function startNewGame() {
    state = deepClone(INITIAL_STATE);
    showScreen("game");
    renderScene(state.currentSceneId); // сам сохранит игру в конце — см. renderScene()
  }

  function continueGame() {
    const saved = loadGame();
    if (!saved) {
      startNewGame();
      return;
    }
    state = saved;
    showScreen("game");
    renderScene(state.currentSceneId);
  }

  function restartGame() {
    clearSave();
    startNewGame();
  }

  // Сводка сохранения в главном меню: показывает, на какой сцене (номер
  // главы по счётчику собранных улик — понятнее игроку, чем внутренний id)
  // и с какими показателями остановился прогресс, плюс включает/выключает
  // кнопки "Продолжить" и "Стереть сохранение".
  function renderSaveInfo() {
    const saved = loadGame();
    if (!saved) {
      el.btnContinue.disabled = true;
      el.saveInfo.classList.add("hidden");
      el.btnEraseSave.classList.add("hidden");
      return;
    }
    el.btnContinue.disabled = false;
    el.saveInfo.classList.remove("hidden");
    el.btnEraseSave.classList.remove("hidden");
    el.saveInfo.textContent =
      "Сохранённая игра — улик собрано: " + saved.clues.length +
      ", рассудок: " + saved.sanity +
      ", подозрение: " + saved.suspicion + ".";
  }

  /* ------------------------------------------------------------------
     ОБРАБОТЧИКИ СОБЫТИЙ UI
     ------------------------------------------------------------------ */

  // Web Audio API запрещает звук до первого пользовательского жеста —
  // "разблокируем" контекст на любом клике по кнопкам старта партии.
  el.btnNewGame.addEventListener("click", () => {
    if (window.GameAudio) window.GameAudio.unlock();
    startNewGame();
  });
  el.btnContinue.addEventListener("click", () => {
    if (window.GameAudio) window.GameAudio.unlock();
    continueGame();
  });
  el.btnEraseSave.addEventListener("click", () => {
    if (confirm("Стереть сохранённую игру? Это действие необратимо.")) {
      clearSave();
      renderSaveInfo();
    }
  });
  el.btnRestart.addEventListener("click", () => {
    if (confirm("Начать заново? Текущий прогресс будет удалён.")) {
      restartGame();
    }
  });
  el.btnRestartEnd.addEventListener("click", restartGame);

  el.btnSoundToggle.addEventListener("click", () => {
    if (window.GameAudio) window.GameAudio.unlock();
    const isMuted = window.GameAudio ? window.GameAudio.toggleMute() : true;
    el.btnSoundToggle.textContent = isMuted ? "🔇" : "🔊";
    el.btnSoundToggle.classList.toggle("muted", isMuted);
    el.btnSoundToggle.title = isMuted ? "Включить звук" : "Выключить звук";
  });

  el.btnCluesToggle.addEventListener("click", () => toggleCluesPanel());
  el.btnCluesClose.addEventListener("click", () => toggleCluesPanel(false));

  // Кнопка "Далее":
  //   1. Если идёт печать — сразу докрутить текущую реплику до конца.
  //   2. Если есть ещё не показанные реплики сцены — показать следующую.
  //   3. Если реплики закончились — показать головоломку (если есть)
  //      или варианты выбора.
  el.btnNext.addEventListener("click", () => {
    if (isTyping) {
      skipTyping();
      return;
    }

    currentLineIndex++;
    if (currentLineIndex < currentLines.length) {
      renderCurrentLine();
      return;
    }

    // Все реплики сцены показаны
    const scene = SCENES[state.currentSceneId];
    el.btnNext.classList.add("hidden");

    if (scene.puzzle) {
      renderPuzzle(scene.puzzle);
    } else {
      renderChoices(scene.choices);
    }
  });

  // Клик по самому тексту тоже скипает печать (удобно для мобильных).
  el.dialogueText.addEventListener("click", skipTyping);

  // Головоломка: проверка по кнопке и по Enter в поле ввода.
  el.btnPuzzleSubmit.addEventListener("click", submitPuzzleAnswer);
  el.puzzleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitPuzzleAnswer();
    }
  });

  /* ------------------------------------------------------------------
     ИНИЦИАЛИЗАЦИЯ ПРИ ЗАГРУЗКЕ СТРАНИЦЫ
     -------------------------------------------------------------------
     Само сохранение НЕ применяется автоматически без ведома игрока
     (иначе случайный заход на главную страницу после долгого перерыва
     мгновенно швырял бы в середину истории без выбора) — вместо этого
     на экране меню сразу показывается сводка прогресса и активная
     кнопка "Продолжить", которая корректно восстанавливает state из
     localStorage при клике. Само чтение/валидация сохранения (см.
     renderSaveInfo → loadGame → isValidState) происходит уже здесь,
     при каждой перезагрузке страницы.
     ------------------------------------------------------------------ */
  function init() {
    renderSaveInfo();
    showScreen("menu");
  }

  document.addEventListener("DOMContentLoaded", init);

})();
