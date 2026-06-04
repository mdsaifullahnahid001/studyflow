/**
 * ============================================================
 * Study Routine PWA — script.js
 * ============================================================
 * Architecture : Single Page Application (SPA)
 * Storage      : Dexie.js (IndexedDB) + Firebase Firestore
 * Auth         : Firebase Email/Password
 * Libraries    : Dexie, Chart.js, SortableJS, Tesseract.js,
 *                html2canvas, jsPDF
 * ============================================================
 */

"use strict";

/* ============================================================
 * 1. FIREBASE INITIALISATION 
 * ============================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyAQvfw48eMA0Nfk09TkmuChrBiPvVlaCUU",
  authDomain: "studyflow-2b705.firebaseapp.com",
  projectId: "studyflow-2b705",
  storageBucket: "studyflow-2b705.firebasestorage.app",
  messagingSenderId: "35638358501",
  appId: "1:35638358501:web:4f96edc6ca3813a432ff0c",
  measurementId: "G-YR27WD6Q3Y"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

/* ============================================================
 * 2. DEXIE (IndexedDB) SCHEMA
 * ============================================================ */
const localDB = new Dexie("StudyRoutineDB");

localDB.version(1).stores({
  routines : "++id, uid, day, order",          // weekly schedule slots
  logs     : "++id, uid, date, subject, topic, duration, tags",
  notes    : "++id, uid, date, text, imageUrl, tags",
  settings : "uid",                             // user prefs / streak info
  syncQueue: "++id, action, table, payload"     // offline mutation queue
});

/* ============================================================
 * 3. APP STATE
 * ============================================================ */
const state = {
  user          : null,        // Firebase user object
  theme         : "dark",      // "dark" | "light"
  currentView   : "dashboard", // active SPA section
  pomodoro      : {
    phase        : "idle",     // "idle" | "work" | "break"
    remaining    : 25 * 60,    // seconds
    interval     : null,
    workMins     : 25,
    breakMins    : 5,
    sessionsToday: 0
  },
  charts        : {},          // Chart.js instances keyed by canvas id
  sortables     : [],          // SortableJS instances
  streak        : 0,
  points        : 0,
  achievements  : [],
  ocrWorker     : null         // Tesseract worker (lazy-initialised)
};

/* ============================================================
 * 4. DOM HELPERS
 * ============================================================ */

/**
 * Shorthand querySelector.
 * @param {string} sel  CSS selector
 * @param {Element} ctx  Optional parent element
 * @returns {Element|null}
 */
const $ = (sel, ctx = document) => ctx.querySelector(sel);

/**
 * Shorthand querySelectorAll returning an Array.
 * @param {string} sel
 * @param {Element} ctx
 * @returns {Element[]}
 */
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

/**
 * Create an element with optional class, text and attributes.
 * @param {string} tag
 * @param {object} opts  { cls, text, attrs }
 * @returns {HTMLElement}
 */
function el(tag, { cls = "", text = "", attrs = {} } = {}) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text) e.textContent = text;
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
}

/** Display a transient toast notification. */
function toast(msg, type = "info") {
  const wrap = $("#toast-container") || (() => {
    const d = el("div", { attrs: { id: "toast-container" } });
    document.body.appendChild(d);
    return d;
  })();

  const t = el("div", { cls: `toast toast--${type}`, text: msg });
  wrap.appendChild(t);
  setTimeout(() => t.classList.add("toast--visible"), 50);
  setTimeout(() => { t.classList.remove("toast--visible"); setTimeout(() => t.remove(), 400); }, 3200);
}

/** Show / hide a full-screen loading overlay. */
function setLoading(visible) {
  const ov = $("#loading-overlay");
  if (ov) ov.style.display = visible ? "flex" : "none";
}

/* ============================================================
 * 5. AUTH MODULE
 * ============================================================ */
const Auth = {
  /** Register with email + password. */
  async register(email, password, displayName) {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName });
    return cred.user;
  },

  /** Login with email + password. */
  async login(email, password) {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    return cred.user;
  },

  /** Logout. */
  async logout() {
    await auth.signOut();
  },

  /** Observe auth state changes; wires up the SPA. */
  observe() {
    auth.onAuthStateChanged(async user => {
      state.user = user;
      if (user) {
        await App.boot(user);
      } else {
        App.showAuthScreen();
      }
    });
  }
};

/* ============================================================
 * 6. SYNC MODULE  (Dexie ↔ Firestore)
 * ============================================================ */
const Sync = {
  /**
   * Push a local mutation into the sync queue (used when offline).
   * @param {string} action  "set" | "delete"
   * @param {string} table   Firestore collection name
   * @param {object} payload  Document data
   */
  async enqueue(action, table, payload) {
    await localDB.syncQueue.add({ action, table, payload, ts: Date.now() });
  },

  /** Flush all queued mutations to Firestore. */
  async flush() {
    const items = await localDB.syncQueue.toArray();
    if (!items.length || !navigator.onLine) return;

    const batch = db.batch();
    for (const item of items) {
      const ref = item.payload.firestoreId
        ? db.collection(item.table).doc(item.payload.firestoreId)
        : db.collection(item.table).doc();

      if (item.action === "set") {
        batch.set(ref, { ...item.payload, uid: state.user.uid }, { merge: true });
        // Store the Firestore doc ID back in local IndexedDB
        if (!item.payload.firestoreId) {
          await localDB[item.table.replace(`users/${state.user.uid}/`, "")]
            .where("id").equals(item.payload.localId)
            .modify({ firestoreId: ref.id });
        }
      } else if (item.action === "delete") {
        batch.delete(ref);
      }
    }

    await batch.commit();
    await localDB.syncQueue.clear();
    toast("Synced to cloud ☁️", "success");
  },

  /**
   * Pull all Firestore documents for the current user into IndexedDB.
   * Called once on login to bootstrap offline data.
   */
  async pull() {
    if (!navigator.onLine) return;
    const uid = state.user.uid;
    const collections = ["routines", "logs", "notes"];

    for (const col of collections) {
      const snap = await db.collection(col).where("uid", "==", uid).get();
      for (const doc of snap.docs) {
        const data = { ...doc.data(), firestoreId: doc.id };
        await localDB[col].put(data); // upsert
      }
    }
  }
};

// Automatically flush queue when network is restored
window.addEventListener("online", () => Sync.flush());

/* ============================================================
 * 7. GAMIFICATION MODULE
 * ============================================================ */
const ACHIEVEMENTS = [
  { id: "first_log",   label: "First Steps",    icon: "🐣", condition: pts => pts >= 10  },
  { id: "streak_3",    label: "3-Day Streak",   icon: "🔥", condition: (_, streak) => streak >= 3  },
  { id: "streak_7",    label: "Week Warrior",   icon: "⚔️", condition: (_, streak) => streak >= 7  },
  { id: "streak_30",   label: "Monthly Master", icon: "🏆", condition: (_, streak) => streak >= 30 },
  { id: "pts_100",     label: "Century Club",   icon: "💯", condition: pts => pts >= 100 },
  { id: "pts_500",     label: "Scholar",        icon: "🎓", condition: pts => pts >= 500 },
  { id: "ocr_used",    label: "Smart Reader",   icon: "🔬", condition: (_, __, flags) => flags.ocrUsed },
  { id: "pomodoro_5",  label: "Focus Fanatic",  icon: "⏱️", condition: (_, __, flags) => flags.pomodoroSessions >= 5 }
];

const Gamification = {
  /** Award points and check achievements. */
  async award(points, flags = {}) {
    state.points += points;
    await Gamification._saveSettings();
    Gamification.checkAchievements(flags);
    Gamification.renderPoints();
  },

  /** Check and unlock new achievements. */
  checkAchievements(flags = {}) {
    for (const ach of ACHIEVEMENTS) {
      if (state.achievements.includes(ach.id)) continue;
      if (ach.condition(state.points, state.streak, flags)) {
        state.achievements.push(ach.id);
        Gamification._unlockAchievement(ach);
      }
    }
  },

  /** Show unlock animation and save. */
  async _unlockAchievement(ach) {
    toast(`🎉 Achievement unlocked: ${ach.icon} ${ach.label}`, "success");
    await Gamification._saveSettings();
    Gamification.renderAchievements();
  },

  /** Persist settings (points, streak, achievements) to IndexedDB + Firestore. */
  async _saveSettings() {
    const uid = state.user.uid;
    const payload = {
      uid,
      points      : state.points,
      streak      : state.streak,
      achievements: state.achievements
    };
    await localDB.settings.put(payload);
    if (navigator.onLine) {
      await db.collection("settings").doc(uid).set(payload, { merge: true });
    } else {
      await Sync.enqueue("set", "settings", { ...payload, firestoreId: uid });
    }
  },

  /** Load settings from IndexedDB. */
  async load() {
    const s = await localDB.settings.get(state.user.uid);
    if (s) {
      state.points       = s.points       || 0;
      state.streak       = s.streak       || 0;
      state.achievements = s.achievements || [];
    }
  },

  /** Update the points display in the header. */
  renderPoints() {
    const el = $("#points-display");
    if (el) el.textContent = `⭐ ${state.points} pts`;
  },

  /** Render achievement badges grid. */
  renderAchievements() {
    const container = $("#achievements-grid");
    if (!container) return;
    container.innerHTML = "";

    for (const ach of ACHIEVEMENTS) {
      const unlocked = state.achievements.includes(ach.id);
      const badge    = el("div", { cls: `badge ${unlocked ? "badge--unlocked" : "badge--locked"}` });
      badge.innerHTML = `<span class="badge__icon">${ach.icon}</span>
                         <span class="badge__label">${ach.label}</span>`;
      badge.title     = unlocked ? "Unlocked!" : "Locked";
      container.appendChild(badge);
    }
  }
};

/* ============================================================
 * 8. STREAK CALCULATOR
 * ============================================================ */
const Streak = {
  /**
   * Recalculate the streak based on study log records.
   * A streak increments if there is at least one log entry for
   * each consecutive day ending yesterday (or today).
   */
  async recalculate() {
    const uid  = state.user.uid;
    const logs = await localDB.logs.where("uid").equals(uid).toArray();

    // Collect unique study dates (YYYY-MM-DD)
    const dates = new Set(logs.map(l => l.date));

    let streak  = 0;
    let cursor  = new Date();
    cursor.setHours(0, 0, 0, 0);

    // Allow counting today if there's a log for today
    const todayStr = Streak._fmt(cursor);
    if (!dates.has(todayStr)) {
      // Step back to yesterday before counting
      cursor.setDate(cursor.getDate() - 1);
    }

    while (dates.has(Streak._fmt(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    state.streak = streak;
    await Gamification._saveSettings();
    Gamification.checkAchievements();

    const el = $("#streak-display");
    if (el) el.textContent = `🔥 ${streak} day streak`;
    return streak;
  },

  /** Format a Date as YYYY-MM-DD. */
  _fmt(d) {
    return d.toISOString().split("T")[0];
  },

  /** Return today's date string. */
  today() {
    return Streak._fmt(new Date());
  }
};

/* ============================================================
 * 9. ROUTINE (WEEKLY SCHEDULE) MODULE
 * ============================================================ */
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const Routine = {
  /** Render the drag-and-drop weekly schedule. */
  async render() {
    const uid     = state.user.uid;
    const wrapper = $("#routine-board");
    if (!wrapper) return;
    wrapper.innerHTML = "";

    // Destroy old SortableJS instances to avoid memory leaks
    state.sortables.forEach(s => s.destroy());
    state.sortables = [];

    for (const day of DAYS) {
      const col   = el("div", { cls: "routine-col", attrs: { "data-day": day } });
      const title = el("h3", { cls: "routine-col__title", text: day });
      const list  = el("ul", { cls: "routine-list", attrs: { "data-day": day } });

      // Fetch slots for this day ordered by 'order'
      const slots = await localDB.routines
        .where("[uid+day]").equals([uid, day])
        .sortBy("order");

      slots.forEach(slot => list.appendChild(Routine._slotEl(slot)));

      // "Add slot" button
      const addBtn = el("button", { cls: "btn btn--ghost btn--sm", text: "+ Add Slot" });
      addBtn.addEventListener("click", () => Routine.promptAdd(day));

      col.append(title, list, addBtn);
      wrapper.appendChild(col);

      // Attach SortableJS for drag-and-drop reordering
      const sortable = new Sortable(list, {
        group        : "routine",  // allow cross-day dragging
        animation    : 150,
        ghostClass   : "sortable-ghost",
        onEnd        : Routine._onDragEnd
      });
      state.sortables.push(sortable);
    }
  },

  /** Build a single slot list-item element. */
  _slotEl(slot) {
    const li      = el("li", { cls: "routine-slot", attrs: { "data-id": slot.id } });
    li.style.borderLeftColor = slot.color || "#6c63ff";
    li.innerHTML  = `
      <span class="routine-slot__subject">${slot.subject}</span>
      <span class="routine-slot__time">${slot.startTime} – ${slot.endTime}</span>
      <span class="routine-slot__tag tag tag--${slot.color ? "custom" : "default"}"
            style="background:${slot.color || ""}">
        ${slot.tag || ""}
      </span>
      <button class="routine-slot__del" aria-label="Delete slot" data-id="${slot.id}">×</button>`;

    li.querySelector(".routine-slot__del").addEventListener("click", e => {
      e.stopPropagation();
      Routine.delete(Number(e.target.dataset.id));
    });
    return li;
  },

  /** Persist re-ordered slots after a drag-and-drop operation. */
  async _onDragEnd(evt) {
    const list   = evt.to;
    const day    = list.dataset.day;
    const uid    = state.user.uid;
    const items  = $$("li.routine-slot", list);

    for (let i = 0; i < items.length; i++) {
      const id = Number(items[i].dataset.id);
      await localDB.routines.update(id, { order: i, day });
    }
    await Sync.flush();
  },

  /** Open a dialog to add a new slot. */
  async promptAdd(day) {
    // In a production build this would open a modal; here we use a simple
    // structured prompt pattern so the JS remains self-contained.
    const subject   = prompt(`Subject for ${day}:`);
    if (!subject) return;
    const startTime = prompt("Start time (e.g. 09:00):", "09:00") || "09:00";
    const endTime   = prompt("End time (e.g. 10:00):", "10:00")   || "10:00";
    const tag       = prompt("Tag (optional):", "") || "";
    const color     = prompt("Colour hex (optional):", "#6c63ff") || "#6c63ff";

    const slot = {
      uid,
      day,
      subject,
      startTime,
      endTime,
      tag,
      color,
      order: 9999
    };

    const localId = await localDB.routines.add(slot);
    if (navigator.onLine) {
      const ref = await db.collection("routines").add({ ...slot, localId });
      await localDB.routines.update(localId, { firestoreId: ref.id });
    } else {
      await Sync.enqueue("set", "routines", { ...slot, localId });
    }

    await Routine.render();
    toast("Slot added ✅", "success");
  },

  /** Delete a routine slot by local ID. */
  async delete(id) {
    const slot = await localDB.routines.get(id);
    if (!slot) return;
    await localDB.routines.delete(id);
    if (navigator.onLine && slot.firestoreId) {
      await db.collection("routines").doc(slot.firestoreId).delete();
    } else {
      await Sync.enqueue("delete", "routines", { firestoreId: slot.firestoreId });
    }
    await Routine.render();
    toast("Slot removed", "info");
  }
};

/* ============================================================
 * 10. STUDY LOG MODULE
 * ============================================================ */
const Log = {
  /** Render the study log view with today's entries and a quick-add form. */
  async render() {
    const uid       = state.user.uid;
    const today     = Streak.today();
    const container = $("#log-container");
    if (!container) return;
    container.innerHTML = "";

    // Form
    container.appendChild(Log._formEl());

    // Entries for today
    const entries = await localDB.logs
      .where("[uid+date]").equals([uid, today])
      .reverse()
      .toArray();

    if (entries.length === 0) {
      container.appendChild(el("p", { cls: "empty-state", text: "No logs for today yet. Start studying! 📚" }));
      return;
    }

    const list = el("ul", { cls: "log-list" });
    entries.forEach(entry => list.appendChild(Log._entryEl(entry)));
    container.appendChild(list);
  },

  /** Build the quick-add log form. */
  _formEl() {
    const form = el("div", { cls: "log-form card" });
    form.innerHTML = `
      <h3 class="card__title">Log Study Session</h3>
      <div class="form-row">
        <input id="log-subject"  class="input" type="text"   placeholder="Subject (e.g. Math)" />
        <input id="log-topic"    class="input" type="text"   placeholder="Topic (e.g. Calculus)" />
        <input id="log-duration" class="input" type="number" placeholder="Duration (mins)" min="1" />
        <input id="log-tags"     class="input" type="text"   placeholder="Tags (comma-separated)" />
        <input id="log-date"     class="input" type="date"   value="${Streak.today()}" />
        <button id="log-submit-btn" class="btn btn--primary">Add Log</button>
      </div>`;

    form.querySelector("#log-submit-btn").addEventListener("click", () => Log.add());
    return form;
  },

  /** Build a single log entry element. */
  _entryEl(entry) {
    const li = el("li", { cls: "log-entry card" });
    const tags = (entry.tags || []).map(t => `<span class="tag">${t}</span>`).join(" ");
    li.innerHTML = `
      <div class="log-entry__header">
        <strong>${entry.subject}</strong> — <span>${entry.topic}</span>
      </div>
      <div class="log-entry__meta">
        <span>⏱ ${entry.duration} mins</span>
        <span>📅 ${entry.date}</span>
        <span>${tags}</span>
      </div>
      <button class="log-entry__del btn btn--ghost btn--sm" data-id="${entry.id}">Delete</button>`;

    li.querySelector(".log-entry__del").addEventListener("click", e => Log.delete(Number(e.target.dataset.id)));
    return li;
  },

  /** Save a new log entry. */
  async add() {
    const subject  = $("#log-subject")?.value.trim();
    const topic    = $("#log-topic")?.value.trim();
    const duration = parseInt($("#log-duration")?.value || "0");
    const tags     = ($("#log-tags")?.value || "").split(",").map(t => t.trim()).filter(Boolean);
    const date     = $("#log-date")?.value || Streak.today();

    if (!subject || !topic || !duration) {
      toast("Please fill in subject, topic and duration.", "error");
      return;
    }

    const entry = { uid: state.user.uid, date, subject, topic, duration, tags };
    const localId = await localDB.logs.add(entry);

    if (navigator.onLine) {
      const ref = await db.collection("logs").add({ ...entry, localId });
      await localDB.logs.update(localId, { firestoreId: ref.id });
    } else {
      await Sync.enqueue("set", "logs", { ...entry, localId });
    }

    // Points: 10 base + 1 per minute (capped at 60 bonus)
    await Gamification.award(10 + Math.min(duration, 60));
    await Streak.recalculate();
    await Log.render();
    await Progress.render();
    await Heatmap.render();
    toast("Session logged! 🎉", "success");
  },

  /** Delete a log entry by local ID. */
  async delete(id) {
    const entry = await localDB.logs.get(id);
    if (!entry) return;
    await localDB.logs.delete(id);
    if (navigator.onLine && entry.firestoreId) {
      await db.collection("logs").doc(entry.firestoreId).delete();
    }
    await Log.render();
    toast("Entry deleted", "info");
  }
};

/* ============================================================
 * 11. SMART NOTES (with OCR) MODULE
 * ============================================================ */
const Notes = {
  /** Render notes list and capture form. */
  async render() {
    const uid       = state.user.uid;
    const container = $("#notes-container");
    if (!container) return;
    container.innerHTML = "";

    container.appendChild(Notes._formEl());

    const notes = await localDB.notes
      .where("uid").equals(uid)
      .reverse()
      .toArray();

    if (notes.length === 0) {
      container.appendChild(el("p", { cls: "empty-state", text: "No notes yet. Capture something! 📷" }));
      return;
    }

    const grid = el("div", { cls: "notes-grid" });
    notes.forEach(n => grid.appendChild(Notes._noteEl(n)));
    container.appendChild(grid);
  },

  /** Build the note capture form. */
  _formEl() {
    const form = el("div", { cls: "note-form card" });
    form.innerHTML = `
      <h3 class="card__title">New Smart Note</h3>
      <textarea id="note-text" class="input textarea" placeholder="Type your note, or use camera/gallery below…"></textarea>
      <div class="note-form__actions">
        <input id="note-image-input" type="file" accept="image/*" capture="environment" style="display:none" />
        <button id="note-camera-btn"  class="btn btn--secondary">📷 Camera / Gallery</button>
        <button id="note-ocr-btn"     class="btn btn--secondary" style="display:none">🔬 Run OCR</button>
        <input id="note-tags-input"   class="input" type="text" placeholder="Tags (comma-separated)" />
        <button id="note-save-btn"    class="btn btn--primary">Save Note</button>
      </div>
      <img id="note-preview" class="note-preview" style="display:none" alt="Image preview" />`;

    const fileInput = form.querySelector("#note-image-input");
    const ocrBtn    = form.querySelector("#note-ocr-btn");
    const preview   = form.querySelector("#note-preview");
    let capturedDataUrl = null;

    // Open file picker (camera or gallery)
    form.querySelector("#note-camera-btn").addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      capturedDataUrl = await Notes._fileToDataUrl(file);
      preview.src     = capturedDataUrl;
      preview.style.display = "block";
      ocrBtn.style.display  = "inline-flex";
    });

    // Run Tesseract OCR on the captured image
    ocrBtn.addEventListener("click", async () => {
      if (!capturedDataUrl) return;
      ocrBtn.disabled    = true;
      ocrBtn.textContent = "⏳ Running OCR…";
      try {
        const text = await Notes._runOcr(capturedDataUrl);
        form.querySelector("#note-text").value += (form.querySelector("#note-text").value ? "\n" : "") + text;
        toast("OCR complete 🔬", "success");
        await Gamification.award(5, { ocrUsed: true });
      } catch (err) {
        toast("OCR failed: " + err.message, "error");
      } finally {
        ocrBtn.disabled    = false;
        ocrBtn.textContent = "🔬 Run OCR";
      }
    });

    form.querySelector("#note-save-btn").addEventListener("click", () =>
      Notes.save(
        form.querySelector("#note-text").value,
        capturedDataUrl,
        form.querySelector("#note-tags-input").value
      )
    );

    return form;
  },

  /** Convert a File object to a base-64 data URL. */
  _fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload  = e => res(e.target.result);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
  },

  /** Run Tesseract OCR on a data URL; returns recognised text. */
  async _runOcr(dataUrl) {
    if (!state.ocrWorker) {
      state.ocrWorker = Tesseract.createWorker();
      await state.ocrWorker.load();
      await state.ocrWorker.loadLanguage("eng");
      await state.ocrWorker.initialize("eng");
    }
    const { data: { text } } = await state.ocrWorker.recognize(dataUrl);
    return text.trim();
  },

  /** Build a single note card element. */
  _noteEl(note) {
    const card = el("div", { cls: "note-card card" });
    const tags = (note.tags || []).map(t => `<span class="tag">${t}</span>`).join(" ");
    card.innerHTML = `
      ${note.imageUrl ? `<img class="note-card__img" src="${note.imageUrl}" alt="Note image" />` : ""}
      <p class="note-card__text">${note.text || ""}</p>
      <div class="note-card__footer">
        <span class="note-card__date">${note.date}</span>
        <span>${tags}</span>
        <button class="btn btn--ghost btn--sm note-card__del" data-id="${note.id}">×</button>
      </div>`;

    card.querySelector(".note-card__del").addEventListener("click", e =>
      Notes.delete(Number(e.target.dataset.id))
    );
    return card;
  },

  /** Persist a new note. */
  async save(text, imageUrl, tagsRaw) {
    if (!text && !imageUrl) {
      toast("Nothing to save.", "error");
      return;
    }
    const tags  = (tagsRaw || "").split(",").map(t => t.trim()).filter(Boolean);
    const note  = { uid: state.user.uid, date: Streak.today(), text, imageUrl, tags };
    const localId = await localDB.notes.add(note);

    // Store imageUrl only as a reference; for production, upload to Firebase Storage
    if (navigator.onLine) {
      const ref = await db.collection("notes").add({ ...note, imageUrl: imageUrl ? "[stored locally]" : null, localId });
      await localDB.notes.update(localId, { firestoreId: ref.id });
    } else {
      await Sync.enqueue("set", "notes", { ...note, imageUrl: null, localId });
    }

    await Gamification.award(5);
    await Notes.render();
    toast("Note saved 📝", "success");
  },

  /** Delete a note by local ID. */
  async delete(id) {
    const note = await localDB.notes.get(id);
    if (!note) return;
    await localDB.notes.delete(id);
    if (navigator.onLine && note.firestoreId) {
      await db.collection("notes").doc(note.firestoreId).delete();
    }
    await Notes.render();
  }
};

/* ============================================================
 * 12. PROGRESS TRACKER MODULE  (Chart.js)
 * ============================================================ */
const Progress = {
  /** Render the week-over-week bar chart and per-subject doughnut. */
  async render() {
    const uid  = state.user.uid;
    const logs = await localDB.logs.where("uid").equals(uid).toArray();

    Progress._renderBarChart(logs);
    Progress._renderDoughnut(logs);
    Progress._renderStats(logs);
  },

  /** Build a bar chart of daily study minutes for the last 14 days. */
  _renderBarChart(logs) {
    const canvas = $("#progress-bar-chart");
    if (!canvas) return;

    const days   = 14;
    const labels = [];
    const data   = [];

    for (let i = days - 1; i >= 0; i--) {
      const d   = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      labels.push(key.slice(5));     // MM-DD
      const total = logs.filter(l => l.date === key).reduce((s, l) => s + (l.duration || 0), 0);
      data.push(total);
    }

    if (state.charts["bar"]) state.charts["bar"].destroy();
    state.charts["bar"] = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label     : "Minutes Studied",
          data,
          backgroundColor: "rgba(108, 99, 255, 0.7)",
          borderColor    : "#6c63ff",
          borderWidth    : 2,
          borderRadius   : 6
        }]
      },
      options: {
        responsive: true,
        plugins   : { legend: { display: false } },
        scales    : { y: { beginAtZero: true } }
      }
    });
  },

  /** Build a doughnut chart breaking minutes by subject. */
  _renderDoughnut(logs) {
    const canvas = $("#progress-doughnut-chart");
    if (!canvas) return;

    const map = {};
    logs.forEach(l => { map[l.subject] = (map[l.subject] || 0) + (l.duration || 0); });
    const labels = Object.keys(map);
    const data   = labels.map(k => map[k]);

    if (state.charts["doughnut"]) state.charts["doughnut"].destroy();
    state.charts["doughnut"] = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: [
            "#6c63ff", "#ff6584", "#43e97b", "#f7971e",
            "#00b4db", "#f953c6", "#b91d73", "#2af598"
          ]
        }]
      },
      options: {
        responsive: true,
        plugins   : { legend: { position: "bottom" } }
      }
    });
  },

  /** Render summary stats cards. */
  _renderStats(logs) {
    const totalMins    = logs.reduce((s, l) => s + (l.duration || 0), 0);
    const uniqueSubj   = new Set(logs.map(l => l.subject)).size;
    const totalSessions = logs.length;

    const stats = [
      { label: "Total Study Time", value: `${Math.floor(totalMins / 60)}h ${totalMins % 60}m` },
      { label: "Subjects Covered",  value: uniqueSubj },
      { label: "Total Sessions",    value: totalSessions },
      { label: "Current Streak",    value: `🔥 ${state.streak} days` },
      { label: "Points",            value: `⭐ ${state.points}` }
    ];

    const container = $("#stats-cards");
    if (!container) return;
    container.innerHTML = "";

    stats.forEach(s => {
      const card = el("div", { cls: "stat-card card" });
      card.innerHTML = `<span class="stat-card__value">${s.value}</span>
                        <span class="stat-card__label">${s.label}</span>`;
      container.appendChild(card);
    });
  }
};

/* ============================================================
 * 13. HEATMAP (Calendar Contribution View) MODULE
 * ============================================================ */
const Heatmap = {
  /** Render a GitHub-style contribution heatmap for the current year. */
  async render() {
    const container = $("#heatmap-container");
    if (!container) return;
    container.innerHTML = "";

    const uid  = state.user.uid;
    const logs = await localDB.logs.where("uid").equals(uid).toArray();

    // Aggregate minutes per day
    const minutesByDate = {};
    logs.forEach(l => {
      minutesByDate[l.date] = (minutesByDate[l.date] || 0) + (l.duration || 0);
    });

    // Determine max minutes for colour scaling
    const maxMins  = Math.max(...Object.values(minutesByDate), 1);
    const today    = new Date();
    const yearStart = new Date(today.getFullYear(), 0, 1);

    const title = el("h3", { cls: "heatmap__title", text: `${today.getFullYear()} Study Activity` });
    const grid  = el("div", { cls: "heatmap-grid" });

    // Pad to the Monday of the week containing Jan 1
    const startDay = (yearStart.getDay() + 6) % 7; // Monday = 0
    for (let p = 0; p < startDay; p++) {
      grid.appendChild(el("div", { cls: "heatmap-cell heatmap-cell--pad" }));
    }

    const totalDays = ((today - yearStart) / 86400000) + 1;

    for (let i = 0; i < Math.ceil(totalDays); i++) {
      const d   = new Date(yearStart);
      d.setDate(yearStart.getDate() + i);
      const key = d.toISOString().split("T")[0];
      const mins = minutesByDate[key] || 0;

      const cell = el("div", { cls: "heatmap-cell" });
      cell.title = `${key}: ${mins} mins`;

      const intensity = mins > 0 ? Math.ceil((mins / maxMins) * 4) : 0;
      cell.dataset.level = intensity; // 0–4 for CSS colouring

      grid.appendChild(cell);
    }

    container.append(title, grid);
  }
};

/* ============================================================
 * 14. POMODORO TIMER MODULE
 * ============================================================ */
const Pomodoro = {
  /** Render the Pomodoro widget into the dashboard. */
  render() {
    const container = $("#pomodoro-container");
    if (!container) return;

    container.innerHTML = `
      <div class="pomodoro card">
        <h3 class="card__title">🍅 Focus Timer</h3>
        <div id="pomodoro-phase" class="pomodoro__phase">Ready</div>
        <div id="pomodoro-display" class="pomodoro__display">25:00</div>
        <div class="pomodoro__controls">
          <button id="pom-start"  class="btn btn--primary">▶ Start</button>
          <button id="pom-pause"  class="btn btn--secondary" disabled>⏸ Pause</button>
          <button id="pom-reset"  class="btn btn--ghost">↺ Reset</button>
        </div>
        <div class="pomodoro__config">
          <label>Work <input id="pom-work-mins"  class="input input--sm" type="number" value="${state.pomodoro.workMins}"  min="1" max="60" /></label>
          <label>Break <input id="pom-break-mins" class="input input--sm" type="number" value="${state.pomodoro.breakMins}" min="1" max="30" /></label>
        </div>
        <div class="pomodoro__sessions">Sessions today: <span id="pom-sessions">0</span></div>
      </div>`;

    container.querySelector("#pom-start").addEventListener("click",  () => Pomodoro.start());
    container.querySelector("#pom-pause").addEventListener("click",  () => Pomodoro.pause());
    container.querySelector("#pom-reset").addEventListener("click",  () => Pomodoro.reset());
    container.querySelector("#pom-work-mins").addEventListener("change",  e => {
      state.pomodoro.workMins  = parseInt(e.target.value) || 25;
      if (state.pomodoro.phase === "idle") Pomodoro.reset();
    });
    container.querySelector("#pom-break-mins").addEventListener("change", e => {
      state.pomodoro.breakMins = parseInt(e.target.value) || 5;
    });
  },

  /** Start or resume the timer. */
  start() {
    const p = state.pomodoro;
    if (p.phase === "idle") {
      p.phase     = "work";
      p.remaining = p.workMins * 60;
      Pomodoro._setPhaseLabel("🍅 Focus");
    }
    if (p.interval) return;

    p.interval = setInterval(() => Pomodoro._tick(), 1000);
    $("#pom-start").disabled = true;
    $("#pom-pause").disabled = false;
  },

  /** Pause the timer. */
  pause() {
    clearInterval(state.pomodoro.interval);
    state.pomodoro.interval  = null;
    $("#pom-start").disabled = false;
    $("#pom-pause").disabled = true;
  },

  /** Reset to initial work phase. */
  reset() {
    Pomodoro.pause();
    const p     = state.pomodoro;
    p.phase     = "idle";
    p.remaining = p.workMins * 60;
    Pomodoro._updateDisplay();
    Pomodoro._setPhaseLabel("Ready");
    $("#pom-start").disabled = false;
  },

  /** Called every second by the interval. */
  _tick() {
    const p = state.pomodoro;
    p.remaining--;
    Pomodoro._updateDisplay();

    if (p.remaining <= 0) {
      clearInterval(p.interval);
      p.interval = null;

      if (p.phase === "work") {
        p.sessionsToday++;
        $("#pom-sessions").textContent = p.sessionsToday;
        Gamification.award(20, { pomodoroSessions: p.sessionsToday });
        Pomodoro._notify("🍅 Work session complete! Time for a break.");
        p.phase     = "break";
        p.remaining = p.breakMins * 60;
        Pomodoro._setPhaseLabel("☕ Break");
        p.interval  = setInterval(() => Pomodoro._tick(), 1000);
        $("#pom-start").disabled = true;
        $("#pom-pause").disabled = false;
      } else {
        Pomodoro._notify("☕ Break over! Ready for the next session?");
        p.phase = "idle";
        Pomodoro._setPhaseLabel("Ready");
        p.remaining = p.workMins * 60;
        Pomodoro._updateDisplay();
        $("#pom-start").disabled = false;
        $("#pom-pause").disabled = true;
      }
    }
  },

  /** Format seconds as MM:SS and update the display. */
  _updateDisplay() {
    const el = $("#pomodoro-display");
    if (!el) return;
    const m = Math.floor(state.pomodoro.remaining / 60).toString().padStart(2, "0");
    const s = (state.pomodoro.remaining % 60).toString().padStart(2, "0");
    el.textContent = `${m}:${s}`;
    document.title = `[${m}:${s}] Study Routine`;
  },

  /** Update the phase label text. */
  _setPhaseLabel(text) {
    const el = $("#pomodoro-phase");
    if (el) el.textContent = text;
  },

  /** Send a browser notification (requires permission). */
  _notify(body) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Study Routine", { body, icon: "/icons/icon-192.png" });
    } else if ("Notification" in window && Notification.permission !== "denied") {
      Notification.requestPermission().then(perm => {
        if (perm === "granted") Pomodoro._notify(body);
      });
    }
  }
};

/* ============================================================
 * 15. EXPORT MODULE  (html2canvas + jsPDF)
 * ============================================================ */
const Exporter = {
  /** Export the currently visible view section to a PDF. */
  async exportPDF(sectionId = "dashboard-main") {
    toast("Generating PDF…", "info");
    try {
      const section = document.getElementById(sectionId);
      if (!section) { toast("Nothing to export.", "error"); return; }

      const canvas  = await html2canvas(section, { scale: 2, useCORS: true });
      const imgData = canvas.toDataURL("image/png");
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
      const w   = pdf.internal.pageSize.getWidth();
      const h   = (canvas.height * w) / canvas.width;

      pdf.addImage(imgData, "PNG", 0, 0, w, h);
      pdf.save(`study-routine-${Streak.today()}.pdf`);
      toast("PDF exported ✅", "success");
    } catch (err) {
      toast("Export failed: " + err.message, "error");
    }
  },

  /** Export a section as a PNG image. */
  async exportImage(sectionId = "dashboard-main") {
    toast("Generating image…", "info");
    try {
      const section = document.getElementById(sectionId);
      if (!section) return;

      const canvas = await html2canvas(section, { scale: 2, useCORS: true });
      const link   = document.createElement("a");
      link.download = `study-routine-${Streak.today()}.png`;
      link.href     = canvas.toDataURL("image/png");
      link.click();
      toast("Image exported ✅", "success");
    } catch (err) {
      toast("Export failed: " + err.message, "error");
    }
  }
};

/* ============================================================
 * 16. THEME MODULE
 * ============================================================ */
const Theme = {
  /** Apply a theme to the document root. */
  apply(theme) {
    document.documentElement.dataset.theme = theme;
    state.theme = theme;
    localStorage.setItem("theme", theme);
    const btn = $("#theme-toggle");
    if (btn) btn.textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
  },

  /** Toggle between dark and light. */
  toggle() {
    Theme.apply(state.theme === "dark" ? "light" : "dark");
  },

  /** Load saved theme preference. */
  init() {
    const saved = localStorage.getItem("theme") || "dark";
    Theme.apply(saved);
  }
};

/* ============================================================
 * 17. ROUTER / NAVIGATION
 * ============================================================ */
const Router = {
  /** Navigate to a named view. */
  async go(view) {
    state.currentView = view;

    // Hide all sections
    $$(".spa-section").forEach(s => s.classList.remove("spa-section--active"));

    // Activate target section
    const target = $(`#section-${view}`);
    if (target) target.classList.add("spa-section--active");

    // Update nav active state
    $$(".nav-link").forEach(l => l.classList.toggle("nav-link--active", l.dataset.view === view));

    // Render view-specific content
    switch (view) {
      case "dashboard": await Router._renderDashboard(); break;
      case "routine":   await Routine.render();           break;
      case "log":       await Log.render();               break;
      case "notes":     await Notes.render();             break;
      case "progress":  await Progress.render();          break;
      case "heatmap":   await Heatmap.render();           break;
      case "achievements": Gamification.renderAchievements(); break;
    }
  },

  /** Dashboard combines several widgets. */
  async _renderDashboard() {
    Pomodoro.render();
    await Progress.render();
    await Heatmap.render();
  }
};

/* ============================================================
 * 18. AUTH UI
 * ============================================================ */
const AuthUI = {
  /** Build and display the login / register screen. */
  show() {
    document.body.innerHTML = `
      <div id="auth-screen" class="auth-screen">
        <div class="auth-card card">
          <h1 class="auth-card__title">📚 Study Routine</h1>
          <p class="auth-card__sub">Your personal study companion</p>

          <div class="auth-tabs">
            <button class="auth-tab auth-tab--active" data-tab="login">Login</button>
            <button class="auth-tab"                  data-tab="register">Register</button>
          </div>

          <!-- LOGIN -->
          <div id="tab-login" class="auth-panel">
            <input id="login-email"    class="input" type="email"    placeholder="Email" />
            <input id="login-password" class="input" type="password" placeholder="Password" />
            <button id="login-btn" class="btn btn--primary btn--full">Login</button>
          </div>

          <!-- REGISTER -->
          <div id="tab-register" class="auth-panel" style="display:none">
            <input id="reg-name"     class="input" type="text"     placeholder="Display Name" />
            <input id="reg-email"    class="input" type="email"    placeholder="Email" />
            <input id="reg-password" class="input" type="password" placeholder="Password (min 6 chars)" />
            <button id="reg-btn" class="btn btn--primary btn--full">Create Account</button>
          </div>

          <p id="auth-error" class="auth-error" style="display:none"></p>
        </div>
      </div>`;

    // Tab switching
    $$(".auth-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        $$(".auth-tab").forEach(t => t.classList.remove("auth-tab--active"));
        tab.classList.add("auth-tab--active");
        $$(".auth-panel").forEach(p => p.style.display = "none");
        $(`#tab-${tab.dataset.tab}`).style.display = "flex";
      });
    });

    // Login
    $("#login-btn").addEventListener("click", async () => {
      const email    = $("#login-email").value.trim();
      const password = $("#login-password").value;
      try {
        setLoading(true);
        await Auth.login(email, password);
      } catch (err) {
        AuthUI._showError(err.message);
      } finally {
        setLoading(false);
      }
    });

    // Register
    $("#reg-btn").addEventListener("click", async () => {
      const name     = $("#reg-name").value.trim();
      const email    = $("#reg-email").value.trim();
      const password = $("#reg-password").value;
      try {
        setLoading(true);
        await Auth.register(email, password, name);
      } catch (err) {
        AuthUI._showError(err.message);
      } finally {
        setLoading(false);
      }
    });
  },

  _showError(msg) {
    const el = $("#auth-error");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
  }
};

/* ============================================================
 * 19. MAIN APP SHELL
 * ============================================================ */
const App = {
  /** Boot the dashboard after successful authentication. */
  async boot(user) {
    setLoading(true);
    try {
      // Pull data from Firestore into IndexedDB
      await Sync.pull();

      // Load gamification state
      await Gamification.load();
      await Streak.recalculate();

      // Render shell
      App._renderShell(user);

      // Navigate to default view
      await Router.go("dashboard");

      // Request notification permission (for Pomodoro)
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }

      // Register Service Worker
      App._registerSW();

      toast(`Welcome back, ${user.displayName || user.email}! 👋`, "success");
    } finally {
      setLoading(false);
    }
  },

  /** Render the persistent app chrome (nav, header). */
  _renderShell(user) {
    document.body.innerHTML = `
      <!-- Loading Overlay -->
      <div id="loading-overlay" style="display:none">
        <div class="spinner"></div>
      </div>

      <!-- Toast Container -->
      <div id="toast-container"></div>

      <!-- Header -->
      <header class="app-header">
        <div class="app-header__brand">📚 Study Routine</div>
        <div class="app-header__meta">
          <span id="streak-display">🔥 0 day streak</span>
          <span id="points-display">⭐ 0 pts</span>
          <span class="app-header__user">${user.displayName || user.email}</span>
          <button id="theme-toggle" class="btn btn--ghost btn--sm">🌙 Dark</button>
          <button id="logout-btn"   class="btn btn--ghost btn--sm">Logout</button>
        </div>
      </header>

      <!-- Navigation -->
      <nav class="app-nav">
        <button class="nav-link" data-view="dashboard">🏠 Dashboard</button>
        <button class="nav-link" data-view="routine">📅 Schedule</button>
        <button class="nav-link" data-view="log">📝 Log</button>
        <button class="nav-link" data-view="notes">🔬 Notes</button>
        <button class="nav-link" data-view="progress">📊 Progress</button>
        <button class="nav-link" data-view="heatmap">🗓 Heatmap</button>
        <button class="nav-link" data-view="achievements">🏆 Badges</button>
      </nav>

      <!-- SPA Sections -->
      <main class="app-main" id="dashboard-main">
        <section id="section-dashboard" class="spa-section">
          <div id="pomodoro-container"></div>
          <div id="stats-cards" class="stats-cards"></div>
          <div class="charts-row">
            <canvas id="progress-bar-chart"      class="chart-canvas"></canvas>
            <canvas id="progress-doughnut-chart" class="chart-canvas"></canvas>
          </div>
          <div id="heatmap-container"></div>
        </section>

        <section id="section-routine" class="spa-section">
          <div class="section-header">
            <h2>Weekly Schedule</h2>
          </div>
          <div id="routine-board" class="routine-board"></div>
        </section>

        <section id="section-log" class="spa-section">
          <div class="section-header"><h2>Study Log</h2></div>
          <div id="log-container"></div>
        </section>

        <section id="section-notes" class="spa-section">
          <div class="section-header"><h2>Smart Notes</h2></div>
          <div id="notes-container"></div>
        </section>

        <section id="section-progress" class="spa-section">
          <div class="section-header">
            <h2>Progress Tracker</h2>
            <div class="section-header__actions">
              <button class="btn btn--secondary btn--sm" onclick="Exporter.exportPDF()">⬇ PDF</button>
              <button class="btn btn--secondary btn--sm" onclick="Exporter.exportImage()">🖼 Image</button>
            </div>
          </div>
          <div id="stats-cards" class="stats-cards"></div>
          <div class="charts-row">
            <canvas id="progress-bar-chart"      class="chart-canvas"></canvas>
            <canvas id="progress-doughnut-chart" class="chart-canvas"></canvas>
          </div>
        </section>

        <section id="section-heatmap" class="spa-section">
          <div class="section-header"><h2>Contribution Heatmap</h2></div>
          <div id="heatmap-container"></div>
        </section>

        <section id="section-achievements" class="spa-section">
          <div class="section-header"><h2>Achievement Badges</h2></div>
          <div id="achievements-grid" class="achievements-grid"></div>
        </section>
      </main>`;

    // Wire up navigation
    $$(".nav-link").forEach(btn =>
      btn.addEventListener("click", () => Router.go(btn.dataset.view))
    );

    // Theme toggle
    $("#theme-toggle").addEventListener("click", () => Theme.toggle());
    Theme.init();

    // Logout
    $("#logout-btn").addEventListener("click", async () => {
      await Auth.logout();
      toast("Logged out 👋", "info");
    });

    // Update gamification UI
    Gamification.renderPoints();
  },

  /** Show the unauthenticated login screen. */
  showAuthScreen() {
    document.title = "Study Routine — Login";
    AuthUI.show();
    Theme.init();
  },

  /** Register the Service Worker for offline caching. */
  _registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(err =>
        console.warn("SW registration failed:", err)
      );
    }
  }
};

/* ============================================================
 * 20. ENTRY POINT
 * ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  // Inject a minimal loading overlay before the shell is built
  const overlay = el("div", { attrs: { id: "loading-overlay" } });
  overlay.appendChild(el("div", { cls: "spinner" }));
  document.body.appendChild(overlay);
  setLoading(true);

  // Start observing Firebase auth state — this drives the entire app
  Auth.observe();
});
