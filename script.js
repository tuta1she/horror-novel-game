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
  const TYPE_SPEED_MS = 22; // задержка между символами в эффекте печатной машинки

  /* ------------------------------------------------------------------
     ССЫЛКИ НА DOM-ЭЛЕМЕНТЫ (кешируем один раз при загрузке)
     ------------------------------------------------------------------ */
  const el = {
    bgLayer: document.getElementById("bg-layer"),
    gameRoot: document.getElementById("game-root"),
    flashOverlay: document.getElementById("flash-overlay"),
    mainMenu: document.getElementById("main-menu"),
    gameScreen: document.getElementById("game-screen"),
    endScreen: document.getElementById("end-screen"),
    endScreenText: document.getElementById("end-screen-text"),

    btnNewGame: document.getElementById("btn-new-game"),
    btnContinue: document.getElementById("btn-continue"),
    btnRestart: document.getElementById("btn-restart"),
    btnRestartEnd: document.getElementById("btn-restart-end"),
    btnNext: document.getElementById("btn-next"),

    sanityBar: document.getElementById("sanity-bar"),
    suspicionBar: document.getElementById("suspicion-bar"),

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
     ------------------------------------------------------------------ */

  function saveGame() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("Не удалось сохранить игру:", e);
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.warn("Не удалось прочитать сохранение:", e);
      return null;
    }
  }

  function hasSave() {
    return !!localStorage.getItem(SAVE_KEY);
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
      // В каркасе нет аудиофайлов — просто отмечаем факт для отладки.
      // Здесь легко подключить реальный Audio(), когда появятся файлы:
      // new Audio(`sfx/${effects.sound}.mp3`).play();
      console.log("[звук]", effects.sound);
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
     ОТРИСОВКА HUD (полоски рассудка/подозрения)
     ------------------------------------------------------------------ */
  function renderHud() {
    el.sanityBar.style.width = state.sanity + "%";
    el.suspicionBar.style.width = state.suspicion + "%";
    el.sanityBar.classList.toggle("low", state.sanity <= 25);
  }

  /* ------------------------------------------------------------------
     ОТРИСОВКА ФОНА СЦЕНЫ
     ------------------------------------------------------------------ */
  function applyBackground(backgroundKey) {
    el.bgLayer.className = "";
    el.bgLayer.classList.add(backgroundKey ? "bg-" + backgroundKey : "bg-default");
    el.bgLayer.classList.add("bg-default"); // фоллбэк-градиент под любой фон
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
    saveGame(); // автосейв после КАЖДОГО выбора
    renderScene(state.currentSceneId);
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
        saveGame();
        renderScene(nextId);
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
  }

  /* ------------------------------------------------------------------
     ЭКРАН ФИНАЛА ГЛАВЫ
     ------------------------------------------------------------------ */
  function showEndScreen() {
    el.gameScreen.classList.add("hidden");
    el.endScreen.classList.remove("hidden");
    el.endScreenText.textContent =
      "Собрано улик: " + state.clues.length +
      ". Рассудок: " + state.sanity +
      ". Подозрение: " + state.suspicion + ".";
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
    saveGame();
    showScreen("game");
    renderScene(state.currentSceneId);
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

  /* ------------------------------------------------------------------
     ОБРАБОТЧИКИ СОБЫТИЙ UI
     ------------------------------------------------------------------ */

  el.btnNewGame.addEventListener("click", startNewGame);
  el.btnContinue.addEventListener("click", continueGame);
  el.btnRestart.addEventListener("click", () => {
    if (confirm("Начать заново? Текущий прогресс будет удалён.")) {
      restartGame();
    }
  });
  el.btnRestartEnd.addEventListener("click", restartGame);

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
     ------------------------------------------------------------------ */
  function init() {
    if (hasSave()) {
      el.btnContinue.disabled = false;
    }
    showScreen("menu");
  }

  document.addEventListener("DOMContentLoaded", init);

})();
