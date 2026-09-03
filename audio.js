/* =========================================================================
   audio.js
   -------------------------------------------------------------------------
   Звуковой движок игры, полностью на Web Audio API — без единого внешнего
   аудиофайла. Всё (гул, ветер, скрипы, стук, шаги, крик и т.д.) генерируется
   осцилляторами и шумовыми буферами прямо в браузере.

   Публичный интерфейс — window.GameAudio:
     init()                — создаёт AudioContext и узлы-мастера. Вызывать
                             можно в любой момент, но реальный звук пойдёт
                             только после unlock() (браузеры блокируют звук
                             до первого жеста пользователя).
     unlock()               — "разблокирует" AudioContext по клику/тапу.
                             Вызывается один раз на первый клик в игре.
     setAmbient(sceneKey)   — переключает фоновую атмосферу под конкретную
                             локацию (ключ совпадает с scene.background).
     playEffect(name)       — проигрывает одноразовый эффект по имени
                             (см. EFFECT_PLAYERS ниже).
     setMuted(bool)         — вкл/выкл звук целиком (мастер-громкость).
     toggleMute()           — переключить текущее состояние.
     isMuted()              — текущее состояние (bool).

   Если Web Audio API недоступен (очень старый браузер) — все методы тихо
   ничего не делают, игра не ломается.
   ========================================================================= */

(function () {
  "use strict";

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  // Если API недоступен — отдаём заглушку с теми же методами-пустышками,
  // чтобы script.js мог вызывать GameAudio.* без проверок на каждом шаге.
  if (!AudioContextClass) {
    window.GameAudio = {
      init() {}, unlock() {}, setAmbient() {}, playEffect() {},
      setMuted() {}, toggleMute() { return false; }, isMuted() { return true; }
    };
    return;
  }

  let ctx = null;
  let masterGain = null;   // общая громкость (управляется setMuted)
  let ambientGain = null;  // громкость фоновой атмосферы отдельно от эффектов
  let muted = false;

  // Активные узлы текущего эмбиента — храним, чтобы можно было плавно
  // остановить их при переключении сцены (fade-out + disconnect).
  let activeAmbientNodes = [];
  let creakTimeoutId = null;
  let currentAmbientKey = null;

  /* ------------------------------------------------------------------
     ИНИЦИАЛИЗАЦИЯ / РАЗБЛОКИРОВКА
     ------------------------------------------------------------------ */
  function init() {
    if (ctx) return;
    ctx = new AudioContextClass();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 0.8;
    masterGain.connect(ctx.destination);

    ambientGain = ctx.createGain();
    ambientGain.gain.value = 0.5;
    ambientGain.connect(masterGain);
  }

  function unlock() {
    init();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* игнорируем — попробуем на следующем клике */ });
    }
  }

  /* ------------------------------------------------------------------
     УТИЛИТЫ ГЕНЕРАЦИИ ЗВУКА
     ------------------------------------------------------------------ */

  // Буфер белого шума заданной длительности (секунды). Используется как
  // основа и для ветра (через фильтр), и для коротких шумовых всплесков
  // (шаги, скрип, помехи).
  function createNoiseBuffer(seconds) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  // Короткий тональный "стук"/"удар": быстрая атака, экспоненциальный спад.
  function playTone({ freq = 200, duration = 0.25, type = "sine", gain = 0.5, when = 0 }) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  // Плавный переход частоты (свист ветра, крик, скрежет пластинки).
  function playSweep({ startFreq = 800, endFreq = 200, duration = 0.6, type = "sawtooth", gain = 0.3, when = 0 }) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + duration);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + duration * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  // Короткий шумовой всплеск, пропущенный через фильтр — стук, шаг, треск.
  function playNoiseBurst({ duration = 0.15, filterFreq = 800, filterType = "lowpass", gain = 0.4, when = 0 }) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = createNoiseBuffer(duration + 0.05);
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(masterGain);
    src.start(t0);
    src.stop(t0 + duration + 0.05);
  }

  /* ------------------------------------------------------------------
     ФОНОВЫЙ ЭМБИЕНТ
     -------------------------------------------------------------------
     Три постоянно звучащих слоя, включаемые/выключаемые в разных
     сочетаниях под конкретную локацию:
       - drone: очень низкий гудящий тон (тревожный фон дома)
       - wind:  отфильтрованный шум (гул ветра/сквозняка)
       - creak: редкие короткие скрипы, запускаемые случайно по таймеру
     ------------------------------------------------------------------ */

  function stopAmbient() {
    activeAmbientNodes.forEach((node) => {
      try {
        if (node.gainNode) {
          const now = ctx.currentTime;
          node.gainNode.gain.cancelScheduledValues(now);
          node.gainNode.gain.setValueAtTime(node.gainNode.gain.value, now);
          node.gainNode.gain.linearRampToValueAtTime(0.0001, now + 0.8);
        }
        setTimeout(() => {
          try { node.source.stop(); } catch (e) { /* уже остановлен */ }
        }, 850);
      } catch (e) { /* игнорируем */ }
    });
    activeAmbientNodes = [];
    if (creakTimeoutId) {
      clearTimeout(creakTimeoutId);
      creakTimeoutId = null;
    }
  }

  function startDrone(freq, level) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;

    // Медленный LFO слегка "дышит" громкостью — гул звучит не механически.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = level * 0.3;

    const g = ctx.createGain();
    g.gain.value = 0.0001;

    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    osc.connect(g);
    g.connect(ambientGain);

    osc.start();
    lfo.start();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.linearRampToValueAtTime(level, ctx.currentTime + 2.5);

    activeAmbientNodes.push({ source: osc, gainNode: g });
    activeAmbientNodes.push({ source: lfo, gainNode: null });
  }

  function startWind(level, cutoff) {
    const src = ctx.createBufferSource();
    src.buffer = createNoiseBuffer(4);
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = cutoff;
    filter.Q.value = 0.7;

    // Лёгкая случайная модуляция частоты фильтра — ветер "гуляет".
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = cutoff * 0.4;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    const g = ctx.createGain();
    g.gain.value = 0.0001;

    src.connect(filter);
    filter.connect(g);
    g.connect(ambientGain);

    src.start();
    lfo.start();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.linearRampToValueAtTime(level, ctx.currentTime + 2.5);

    activeAmbientNodes.push({ source: src, gainNode: g });
    activeAmbientNodes.push({ source: lfo, gainNode: null });
  }

  function scheduleCreaks(minDelay, maxDelay) {
    const delay = minDelay + Math.random() * (maxDelay - minDelay);
    creakTimeoutId = setTimeout(() => {
      if (!muted) {
        playSweep({
          startFreq: 300 + Math.random() * 200,
          endFreq: 80 + Math.random() * 60,
          duration: 0.5 + Math.random() * 0.4,
          type: "triangle",
          gain: 0.06
        });
      }
      scheduleCreaks(minDelay, maxDelay);
    }, delay);
  }

  // Пресеты атмосферы по ключу локации (совпадает с scene.background).
  const AMBIENT_PRESETS = {
    storm:      { drone: 48, droneLevel: 0.10, wind: 0.22, windCutoff: 900, creak: [4000, 9000] },
    hall:       { drone: 55, droneLevel: 0.06, wind: 0.05, windCutoff: 500, creak: [6000, 14000] },
    diningroom: { drone: 52, droneLevel: 0.06, wind: 0.03, windCutoff: 400, creak: [7000, 15000] },
    corridor:   { drone: 50, droneLevel: 0.07, wind: 0.06, windCutoff: 450, creak: [5000, 11000] },
    library:    { drone: 60, droneLevel: 0.05, wind: 0.02, windCutoff: 350, creak: [8000, 16000] },
    garden:     { drone: 46, droneLevel: 0.06, wind: 0.16, windCutoff: 700, creak: [6000, 13000] },
    tower:      { drone: 44, droneLevel: 0.07, wind: 0.26, windCutoff: 1100, creak: [4000, 9000] },
    well:       { drone: 40, droneLevel: 0.08, wind: 0.08, windCutoff: 300, creak: [5000, 12000] },
    bedroom:    { drone: 58, droneLevel: 0.05, wind: 0.02, windCutoff: 300, creak: [7000, 16000] },
    night:      { drone: 42, droneLevel: 0.09, wind: 0.04, windCutoff: 350, creak: [3500, 8000] },
    default:    { drone: 55, droneLevel: 0.05, wind: 0.03, windCutoff: 400, creak: [7000, 15000] }
  };

  function setAmbient(sceneKey) {
    if (!ctx) return; // ещё не разблокировано пользовательским кликом
    const key = sceneKey && AMBIENT_PRESETS[sceneKey] ? sceneKey : "default";
    if (key === currentAmbientKey) return; // уже играет то, что нужно
    currentAmbientKey = key;

    stopAmbient();

    const preset = AMBIENT_PRESETS[key];
    startDrone(preset.drone, preset.droneLevel);
    if (preset.wind > 0) {
      startWind(preset.wind, preset.windCutoff);
    }
    scheduleCreaks(preset.creak[0], preset.creak[1]);
  }

  /* ------------------------------------------------------------------
     ОДНОРАЗОВЫЕ ЗВУКОВЫЕ ЭФФЕКТЫ
     -------------------------------------------------------------------
     Вызываются из data.js через effects.sound: "имя" (см. applyEffects
     в script.js). Каждый — чистая функция синтеза, без файлов.
     ------------------------------------------------------------------ */
  const EFFECT_PLAYERS = {
    // Порыв ветра/шторма — нарастающий и стихающий шумовой свист.
    wind_howl() {
      playSweep({ startFreq: 200, endFreq: 900, duration: 1.4, type: "sine", gain: 0.18 });
      playNoiseBurst({ duration: 1.6, filterFreq: 600, filterType: "bandpass", gain: 0.15 });
    },
    // Треск и скрежет граммофонной пластинки.
    record_scratch() {
      playNoiseBurst({ duration: 0.3, filterFreq: 2200, filterType: "highpass", gain: 0.35 });
      playSweep({ startFreq: 1200, endFreq: 300, duration: 0.35, type: "sawtooth", gain: 0.2 });
    },
    // Стук в дверь — два глухих удара.
    knock() {
      playTone({ freq: 110, duration: 0.18, type: "sine", gain: 0.55 });
      playTone({ freq: 100, duration: 0.18, type: "sine", gain: 0.5, when: 0.28 });
    },
    // Шаги — серия коротких приглушённых шумовых всплесков.
    footsteps() {
      for (let i = 0; i < 4; i++) {
        playNoiseBurst({ duration: 0.12, filterFreq: 300, filterType: "lowpass", gain: 0.18, when: i * 0.35 });
      }
    },
    // Скрип двери/половиц — долгий восходяще-нисходящий свист.
    creak() {
      playSweep({ startFreq: 180, endFreq: 420, duration: 0.9, type: "triangle", gain: 0.22 });
    },
    // Крик — резкий взлёт частоты с шумовой составляющей (абстрактный,
    // без реалистичной вокализации — синтезированный тревожный сигнал).
    scream() {
      playSweep({ startFreq: 400, endFreq: 1400, duration: 0.5, type: "sawtooth", gain: 0.25 });
      playNoiseBurst({ duration: 0.6, filterFreq: 1800, filterType: "bandpass", gain: 0.2 });
    },
    // Раскат грома — низкий гулкий шумовой удар с долгим спадом.
    thunder() {
      playNoiseBurst({ duration: 1.8, filterFreq: 120, filterType: "lowpass", gain: 0.35 });
      playTone({ freq: 55, duration: 1.6, type: "sine", gain: 0.3 });
    },
    // Глухой стук сердца — два коротких низких удара подряд, для
    // моментов наивысшего напряжения (кульминация, jump-scare).
    heartbeat() {
      playTone({ freq: 65, duration: 0.15, type: "sine", gain: 0.45 });
      playTone({ freq: 60, duration: 0.18, type: "sine", gain: 0.4, when: 0.22 });
    },
    // Звон разбитого стекла/фарфора.
    glass_break() {
      playNoiseBurst({ duration: 0.4, filterFreq: 3500, filterType: "highpass", gain: 0.3 });
    }
  };

  function playEffect(name) {
    if (!ctx || muted || !name) return;
    const player = EFFECT_PLAYERS[name];
    if (player) {
      try { player(); } catch (e) { /* не роняем игру из-за звука */ }
    }
  }

  /* ------------------------------------------------------------------
     УПРАВЛЕНИЕ ГРОМКОСТЬЮ
     ------------------------------------------------------------------ */
  function setMuted(value) {
    muted = !!value;
    if (masterGain) {
      masterGain.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05);
    }
  }
  function toggleMute() {
    setMuted(!muted);
    return muted;
  }
  function isMuted() {
    return muted;
  }

  window.GameAudio = {
    init, unlock, setAmbient, playEffect, setMuted, toggleMute, isMuted
  };
})();
