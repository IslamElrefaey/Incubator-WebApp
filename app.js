// ================================================================
// NeoGuard — Smart Infant Incubator System
// app.js — Main Application Logic
// ================================================================

// ----------------------------------------------------------------
// 1. FIREBASE CONFIGURATION & INITIALIZATION
// ----------------------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyAkyxayqoC1h-nN7rNY2vnPOFK_G0BxqFM",
    authDomain: "infant-incubator-sbme29.firebaseapp.com",
    databaseURL: "https://infant-incubator-sbme29-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "infant-incubator-sbme29",
    storageBucket: "infant-incubator-sbme29.firebasestorage.app",
    messagingSenderId: "718417088331",
    appId: "1:718417088331:web:67431b218ef201513122ce"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// ----------------------------------------------------------------
// 2. GLOBAL STATE
// ----------------------------------------------------------------
let currentUser = null;       // Firebase user object
let currentUserRole = null;       // 'doctor' | 'parent'
let selectedIncubatorId = null;       // Active Firebase incubator key
let activeListeners = [];         // Firebase listener unsubscribe refs
let ecgChart = null;       // Chart.js instance (Doctor)
let ecgChartParent = null;       // Chart.js instance (Parent)
let ecgBuffer = [];         // Rolling ECG values
const ECG_BUFFER_SIZE = 80;

// ----------------------------------------------------------------
// 3. UTILITY HELPERS
// ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);

/** Show a screen by its ID, hide all others */
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
        s.style.display = 'none'; // force hide regardless of CSS specificity
    });
    const target = $(screenId);
    if (target) {
        target.style.display = ''; // restore CSS control
        target.classList.add('active');
    }
}

/** Show / hide loading overlay */
function setLoading(visible, text = 'Loading...') {
    const overlay = $('loading-overlay');
    const label = $('loading-text');
    if (label) label.textContent = text;
    overlay?.classList.toggle('hidden', !visible);
}

/** Display an error message in an auth error div */
function showError(elementId, message) {
    const el = $(elementId);
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
}

/** Clear an error message */
function clearError(elementId) {
    const el = $(elementId);
    if (!el) return;
    el.textContent = '';
    el.classList.add('hidden');
}

/** Generate a random alphanumeric string of given length */
function randomStr(len, chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
    return Array.from({ length: len }, () =>
        chars[Math.floor(Math.random() * chars.length)]
    ).join('');
}

/** Generate a Child Code like NC-A1B2 */
function generateChildCode() {
    return `NC-${randomStr(2)}${Math.floor(10 + Math.random() * 90)}${randomStr(2)}`;
}

/** Generate an 8-char password */
function generatePassword() {
    return randomStr(4) + Math.floor(1000 + Math.random() * 9000);
}

/** Extract initials from a display name */
function getInitials(name = '') {
    return name.trim().split(/\s+/).slice(0, 2)
        .map(w => w[0]?.toUpperCase() ?? '')
        .join('') || '??';
}

/** Remove all active Firebase realtime listeners */
function clearListeners() {
    activeListeners.forEach(off => off());
    activeListeners = [];
}

/** Copy text to clipboard, briefly change button icon */
async function copyToClipboard(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = 'fa-solid fa-check';
            setTimeout(() => { icon.className = 'fa-solid fa-copy'; }, 1800);
        }
    } catch { /* silently fail */ }
}

// ----------------------------------------------------------------
// 4. DARK MODE
// ----------------------------------------------------------------
const THEME_KEY = 'neoguard_theme';

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Update both theme toggle buttons
    ['doc-theme-toggle', 'parent-theme-toggle'].forEach(id => {
        const btn = $(id);
        if (!btn) return;
        btn.querySelector('i').className =
            theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
        btn.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    });
    localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

// Init theme from localStorage
applyTheme(localStorage.getItem(THEME_KEY) || 'light');

// ----------------------------------------------------------------
// 5. UI — AUTH TABS & PASSWORD TOGGLE
// ----------------------------------------------------------------
function initAuthUI() {
    // Tab switching
    $('tab-login')?.addEventListener('click', () => switchTab('login'));
    $('tab-register')?.addEventListener('click', () => switchTab('register'));

    // Password visibility toggles
    document.querySelectorAll('.toggle-password').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = btn.previousElementSibling;
            if (!input) return;
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            btn.querySelector('i').className =
                isPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        });
    });
}

function switchTab(tab) {
    const loginTab = $('tab-login');
    const registerTab = $('tab-register');
    const loginPanel = $('panel-login');
    const regPanel = $('panel-register');

    clearError('login-error');
    clearError('register-error');

    if (tab === 'login') {
        loginTab?.classList.add('active');
        registerTab?.classList.remove('active');
        loginPanel?.classList.add('active');
        regPanel?.classList.remove('active');
        loginTab?.setAttribute('aria-selected', 'true');
        registerTab?.setAttribute('aria-selected', 'false');
    } else {
        registerTab?.classList.add('active');
        loginTab?.classList.remove('active');
        regPanel?.classList.add('active');
        loginPanel?.classList.remove('active');
        registerTab?.setAttribute('aria-selected', 'true');
        loginTab?.setAttribute('aria-selected', 'false');
    }
}

// ----------------------------------------------------------------
// 6. FIREBASE AUTH — REGISTER
// ----------------------------------------------------------------
$('register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('register-error');

    const name = $('reg-name')?.value.trim();
    const email = $('reg-email')?.value.trim();
    const password = $('reg-password')?.value;
    const role = document.querySelector('input[name="user-role"]:checked')?.value || 'doctor';

    if (!name) return showError('register-error', 'Please enter your full name.');
    if (!email) return showError('register-error', 'Please enter a valid email address.');
    if (password.length < 8) return showError('register-error', 'Password must be at least 8 characters.');

    setLoading(true, 'Creating your account...');
    try {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        await cred.user.updateProfile({ displayName: name });

        // Save user profile to Firebase
        await db.ref(`Users/${cred.user.uid}`).set({
            name,
            email,
            role,
            createdAt: Date.now()
        });

        // Auth state observer will handle routing
    } catch (err) {
        setLoading(false);
        showError('register-error', friendlyAuthError(err.code));
    }
});

// ----------------------------------------------------------------
// 7. FIREBASE AUTH — LOGIN
// ----------------------------------------------------------------
$('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('login-error');

    const email = $('login-email')?.value.trim();
    const password = $('login-password')?.value;

    if (!email) return showError('login-error', 'Please enter your email address.');
    if (!password) return showError('login-error', 'Please enter your password.');

    setLoading(true, 'Signing you in...');
    try {
        await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
        setLoading(false);
        showError('login-error', friendlyAuthError(err.code));
    }
});

/** Convert Firebase error codes to human-readable messages */
function friendlyAuthError(code) {
    const messages = {
        'auth/email-already-in-use': 'This email is already registered.',
        'auth/invalid-email': 'The email address is not valid.',
        'auth/weak-password': 'Password is too weak. Use at least 8 characters.',
        'auth/user-not-found': 'No account found with this email.',
        'auth/wrong-password': 'Incorrect password. Please try again.',
        'auth/invalid-credential': 'Incorrect email or password.',
        'auth/too-many-requests': 'Too many attempts. Please wait a moment.',
        'auth/network-request-failed': 'Network error. Check your connection.',
    };
    return messages[code] || 'An unexpected error occurred. Please try again.';
}

// ----------------------------------------------------------------
// 8. FIREBASE AUTH — STATE OBSERVER (Main Router)
// ----------------------------------------------------------------
auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        setLoading(true, 'Loading your dashboard...');

        try {
            const snap = await db.ref(`Users/${user.uid}`).get();
            if (!snap.exists()) {
                await auth.signOut();
                setLoading(false);
                showScreen('auth-screen');
                return;
            }

            const profile = snap.val();
            currentUserRole = profile.role;

            if (currentUserRole === 'doctor') {
                initDoctorDashboard(user, profile);
                showScreen('doctor-screen');
            } else {
                initParentDashboard(user, profile);
                showScreen('parent-screen');
            }
        } catch (err) {
            console.error('Profile fetch error:', err);
            setLoading(false);
            showScreen('auth-screen');
        }

    } else {
        currentUser = null;
        currentUserRole = null;
        clearListeners();
        setLoading(false);
        showScreen('auth-screen');
    }
});

// ----------------------------------------------------------------
// 9. LOGOUT
// ----------------------------------------------------------------
$('doctor-logout-btn')?.addEventListener('click', signOutUser);
$('parent-logout-btn')?.addEventListener('click', signOutUser);

async function signOutUser() {
    setLoading(true, 'Signing out...');
    clearListeners();
    destroyCharts();
    selectedIncubatorId = null;
    await auth.signOut();
}

// ----------------------------------------------------------------
// 10. DROPDOWN MENUS
// ----------------------------------------------------------------
function initDropdown(avatarBtnId, dropdownId) {
    const btn = $(avatarBtnId);
    const dropdown = $(dropdownId);
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.dropdown-menu').forEach(d => d.classList.remove('open'));
        btn.setAttribute('aria-expanded', String(!isOpen));
        if (!isOpen) dropdown.classList.add('open');
    });

    document.addEventListener('click', () => {
        dropdown.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
    });
}

// ----------------------------------------------------------------
// 11. DOCTOR DASHBOARD INITIALIZATION
// ----------------------------------------------------------------
function initDoctorDashboard(user, profile) {
    // Populate nav
    const displayName = profile.name || user.displayName || 'Doctor';
    $('doctor-display-name').textContent = displayName;
    $('doctor-display-email').textContent = user.email;
    $('doctor-avatar-initials').textContent = getInitials(displayName);

    initDropdown('doctor-avatar-btn', 'doctor-dropdown');

    // Theme toggles
    $('doc-theme-toggle')?.addEventListener('click', toggleTheme);

    // Sidebar toggle (mobile)
    $('sidebar-toggle-btn')?.addEventListener('click', () => {
        $('doctor-sidebar')?.classList.toggle('open');
    });

    // Add incubator buttons
    $('add-incubator-btn')?.addEventListener('click', openAddModal);
    $('empty-add-btn')?.addEventListener('click', openAddModal);

    // Init ECG chart
    ecgChart = initECGChart('ecgChart');

    // Load incubator list
    listenToIncubatorList();

    // DB connection state (console only now — badge removed from nav)
    db.ref('.info/connected').on('value', (snap) => {
        console.log('Firebase connection:', snap.val() === true ? 'online' : 'offline');
    });

    setLoading(false);
}

// ----------------------------------------------------------------
// 12. SIDEBAR — LISTEN TO INCUBATOR LIST
// ----------------------------------------------------------------
function listenToIncubatorList() {
    const ref = db.ref('Incubators');
    const handler = ref.on('value', (snap) => {
        const data = snap.val() || {};
        renderIncubatorList(data);
    });
    activeListeners.push(() => ref.off('value', handler));
}

function renderIncubatorList(data) {
    const list = $('incubator-sidebar-list');
    const emptyEl = $('sidebar-empty-state');
    const countEl = $('incubator-count');
    const keys = Object.keys(data);

    if (!list) return;
    countEl.textContent = keys.length;

    // Clear old items (but keep empty state element)
    list.querySelectorAll('.sidebar-item').forEach(el => el.remove());

    if (keys.length === 0) {
        emptyEl?.classList.remove('hidden');
        return;
    }
    emptyEl?.classList.add('hidden');

    keys.forEach(key => {
        const inc = data[key];
        const item = document.createElement('div');
        item.className = 'sidebar-item' + (key === selectedIncubatorId ? ' active' : '');
        item.setAttribute('role', 'listitem');
        item.setAttribute('data-id', key);
        item.innerHTML = `
            <div class="sidebar-item-avatar">
                <i class="fa-solid fa-baby"></i>
            </div>
            <div class="sidebar-item-info">
                <div class="sidebar-item-name">${escapeHtml(inc.babyName || 'Unnamed')}</div>
                <div class="sidebar-item-sub">${escapeHtml(inc.parentName || '—')}</div>
            </div>
            <div class="sidebar-item-online"></div>`;

        item.addEventListener('click', () => {
            selectIncubator(key, inc);
            // Close sidebar on mobile
            $('doctor-sidebar')?.classList.remove('open');
        });

        list.appendChild(item);
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ----------------------------------------------------------------
// 13. SELECT AN INCUBATOR
// ----------------------------------------------------------------
function selectIncubator(id, data) {
    selectedIncubatorId = id;

    // Update sidebar active state
    document.querySelectorAll('.sidebar-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === id);
    });

    // Show the dashboard panel
    $('no-incubator-selected')?.classList.add('hidden');
    const dashboard = $('incubator-dashboard');
    dashboard?.classList.remove('hidden');

    // Populate patient header
    $('dashboard-baby-name').textContent = data.babyName || 'Unknown';
    $('dashboard-parent-name').textContent = data.parentName || '—';
    $('dashboard-child-code').textContent = data.childCode || '—';
    $('dashboard-device-id').textContent = data.deviceId || '—';

    // Clear old sensor listeners and start new ones
    clearSensorListeners();
    listenToSensorData(id);

    // Restore controls
    if (data.controls) {
        const targetTemp = data.controls.targetTemperature;
        if (targetTemp !== undefined) {
            $('target-temp-input').value = targetTemp;
            $('target-temp-slider').value = targetTemp;
            updateSliderTrack($('target-temp-slider'));
        }
        $('photo-therapy-toggle').checked = !!data.controls.photoTherapy;
        const alarm = data.controls.alarmThreshold;
        if (alarm !== undefined) {
            $('alarm-threshold-input').value = alarm;
        }
    }
}

// ----------------------------------------------------------------
// 14. REALTIME SENSOR DATA LISTENER
// ----------------------------------------------------------------
let sensorListeners = [];

function clearSensorListeners() {
    sensorListeners.forEach(off => off());
    sensorListeners = [];
    hideAlert('alert-banner');
}

function listenToSensorData(incubatorId) {
    const sensorRef = db.ref(`Incubators/${incubatorId}/sensors`);

    const handler = sensorRef.on('value', (snap) => {
        const data = snap.val();
        if (!data) return;
        updateSensorUI(data, false);
        updateLastUpdated(); // stamp data freshness
    });

    sensorListeners.push(() => sensorRef.off('value', handler));
    // Register with global listeners too so logout clears them
    activeListeners.push(() => sensorRef.off('value', handler));

    // Simulate ECG from Firebase or locally
    startECGSimulation(incubatorId);
}

function updateSensorUI(data, isParent) {
    const prefix = isParent ? 'p-' : '';

    // Temperature
    const temp = parseFloat(data.temperature);
    if (!isNaN(temp)) {
        const el = $(`${prefix}temp-val`);
        if (el) el.textContent = temp.toFixed(1);
        const progress = $(`${prefix}temp-progress`);
        // Map 34–40°C range to 0–100%
        if (progress) progress.style.width = clamp((temp - 34) / 6 * 100, 0, 100) + '%';
        // Alert if out of range
        if (!isParent) checkTempAlert(temp);
    }

    // Humidity
    const hum = parseFloat(data.humidity);
    if (!isNaN(hum)) {
        const el = $(`${prefix}hum-val`);
        if (el) el.textContent = hum.toFixed(1);
        const progress = $(`${prefix}hum-progress`);
        if (progress) progress.style.width = clamp(hum, 0, 100) + '%';
    }

    // Heart Rate
    const hr = parseFloat(data.heartRate);
    if (!isNaN(hr)) {
        const el = $(`${prefix}hr-val`);
        if (el) el.textContent = Math.round(hr);
        const progress = $(`${prefix}hr-progress`);
        if (progress) progress.style.width = clamp((hr - 80) / 120 * 100, 0, 100) + '%';
    }

    // Jaundice
    if (data.jaundice !== undefined) {
        updateJaundiceUI(data.jaundice, isParent);
    }
}

function updateJaundiceUI(level, isParent) {
    const prefix = isParent ? 'p-' : '';
    const valEl = $(`${prefix}jaundice-val`);
    const indEl = isParent ? $('p-jaundice-indicator') : $('jaundice-indicator');
    const dotEl = indEl?.querySelector('.jaundice-dot');
    const textEl = $(`${prefix}jaundice-level-text`);
    const levelStr = String(level).toLowerCase();

    let label, dotClass, color;

    if (levelStr === 'low' || levelStr === '0') {
        label = 'Low'; dotClass = ''; color = 'var(--color-success)';
    } else if (levelStr === 'medium' || levelStr === '1') {
        label = 'Medium'; dotClass = 'medium'; color = 'var(--color-warning)';
    } else {
        label = 'High'; dotClass = 'high'; color = 'var(--color-danger)';
    }

    if (valEl) { valEl.textContent = label; valEl.style.color = color; }
    if (dotEl) { dotEl.className = 'jaundice-dot ' + dotClass; }
    if (textEl) textEl.textContent = label === 'High' ? '⚠ Elevated bilirubin' :
        label === 'Medium' ? 'Mild jaundice detected' :
            'Normal levels';
}

function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

// ----------------------------------------------------------------
// LAST UPDATED TIMESTAMP
// ----------------------------------------------------------------
let lastUpdateTimer = null;

function updateLastUpdated() {
    const badge = $('last-updated-badge');
    const text = $('last-updated-text');
    if (!badge || !text) return;

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    text.textContent = `Last update: ${timeStr}`;
    badge.classList.remove('stale');
    badge.classList.add('fresh');

    // After 30 seconds without a new update, mark as stale
    clearTimeout(lastUpdateTimer);
    lastUpdateTimer = setTimeout(() => {
        badge.classList.remove('fresh');
        badge.classList.add('stale');
        if (text) text.textContent = 'No data for 30s — check device';
    }, 30000);
}


// ----------------------------------------------------------------
// 15. ALERT LOGIC
// ----------------------------------------------------------------
let alarmThreshold = 38.5;

function checkTempAlert(temp) {
    // Read doctor's set threshold
    const inputEl = $('alarm-threshold-input');
    if (inputEl) alarmThreshold = parseFloat(inputEl.value) || 38.5;

    if (temp > alarmThreshold) {
        showAlert('alert-banner', `⚠ Temperature is HIGH: ${temp.toFixed(1)}°C (Threshold: ${alarmThreshold}°C)`, true);
    } else if (temp < 36.0) {
        showAlert('alert-banner', `⚠ Temperature is LOW: ${temp.toFixed(1)}°C — Check incubator heating!`, true);
    } else {
        hideAlert('alert-banner');
    }
}

function showAlert(id, message, isCritical = false) {
    const el = $(id);
    if (!el) return;
    el.querySelector('span').textContent = message;
    el.classList.remove('hidden');
    el.classList.toggle('critical', isCritical);
}

function hideAlert(id) {
    $(id)?.classList.add('hidden');
}

$('alert-close-btn')?.addEventListener('click', () => hideAlert('alert-banner'));

// ----------------------------------------------------------------
// 16. ECG CHART
// ----------------------------------------------------------------
function initECGChart(canvasId) {
    const canvas = $(canvasId);
    if (!canvas) return null;

    // Destroy existing chart if any
    if (Chart.getChart(canvas)) Chart.getChart(canvas).destroy();

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';

    return new Chart(canvas, {
        type: 'line',
        data: {
            labels: Array(ECG_BUFFER_SIZE).fill(''),
            datasets: [{
                label: 'ECG',
                data: Array(ECG_BUFFER_SIZE).fill(0),
                borderColor: '#ef4444',
                borderWidth: 1.8,
                fill: true,
                backgroundColor: 'rgba(239,68,68,0.06)',
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 0,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: {
                    min: -1.5,
                    max: 2.5,
                    display: true,
                    grid: { color: gridColor },
                    ticks: {
                        color: isDark ? '#475569' : '#94a3b8',
                        font: { size: 10 },
                        maxTicksLimit: 5,
                    }
                }
            }
        }
    });
}

function destroyCharts() {
    if (ecgChart) { ecgChart.destroy(); ecgChart = null; }
    if (ecgChartParent) { ecgChartParent.destroy(); ecgChartParent = null; }
    ecgBuffer = [];
}

/** Push a new ECG sample into the rolling chart */
function pushECGSample(chart, value) {
    if (!chart) return;
    const dataset = chart.data.datasets[0];
    dataset.data.push(value);
    if (dataset.data.length > ECG_BUFFER_SIZE) dataset.data.shift();
    chart.update('none');
}

/** Simulate a realistic ECG waveform locally (or read from Firebase) */
let ecgSimInterval = null;
let ecgPhase = 0;

function startECGSimulation(incubatorId) {
    stopECGSimulation();

    // Try to read ECG from Firebase first; fall back to simulation
    const ecgRef = db.ref(`Incubators/${incubatorId}/sensors/ecg`);
    let usingCloud = false;

    const ecgHandler = ecgRef.on('value', (snap) => {
        const val = snap.val();
        if (val !== null && val !== undefined) {
            usingCloud = true;
            pushECGSample(ecgChart, parseFloat(val));
            pushECGSample(ecgChartParent, parseFloat(val));
        }
    });
    activeListeners.push(() => ecgRef.off('value', ecgHandler));

    // Start local simulation (runs alongside; if cloud data arrives it takes over visually)
    ecgSimInterval = setInterval(() => {
        if (!usingCloud) {
            const sample = generateECGSample();
            pushECGSample(ecgChart, sample);
            pushECGSample(ecgChartParent, sample);
        }
    }, 40); // ~25 FPS
}

function stopECGSimulation() {
    if (ecgSimInterval) { clearInterval(ecgSimInterval); ecgSimInterval = null; }
}

/** Generate one synthetic ECG sample based on a phase counter */
function generateECGSample() {
    ecgPhase += 0.08;
    if (ecgPhase > 2 * Math.PI) ecgPhase -= 2 * Math.PI;

    const t = ecgPhase;

    // P wave
    let val = 0.2 * Math.exp(-Math.pow((t - 0.5) * 8, 2));
    // QRS complex
    val += -0.3 * Math.exp(-Math.pow((t - 1.0) * 18, 2));
    val += 1.8 * Math.exp(-Math.pow((t - 1.15) * 22, 2));
    val += -0.2 * Math.exp(-Math.pow((t - 1.3) * 18, 2));
    // T wave
    val += 0.35 * Math.exp(-Math.pow((t - 1.9) * 7, 2));
    // Baseline noise
    val += (Math.random() - 0.5) * 0.04;

    return val;
}

// ----------------------------------------------------------------
// 17. ADD INCUBATOR MODAL
// ----------------------------------------------------------------
function openAddModal() {
    $('add-incubator-form')?.reset();
    clearError('add-incubator-error');
    $('add-incubator-modal')?.classList.remove('hidden');
    $('esp-device-id')?.focus();
}

function closeAddModal() {
    $('add-incubator-modal')?.classList.add('hidden');
}

$('modal-close-btn')?.addEventListener('click', closeAddModal);
$('modal-cancel-btn')?.addEventListener('click', closeAddModal);

// Close modal on overlay click
$('add-incubator-modal')?.addEventListener('click', (e) => {
    if (e.target === $('add-incubator-modal')) closeAddModal();
});

$('add-incubator-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('add-incubator-error');

    const deviceId = $('esp-device-id')?.value.trim();
    const babyName = $('new-baby-name')?.value.trim();
    const parentName = $('new-parent-name')?.value.trim();

    if (!deviceId) return showError('add-incubator-error', 'Please enter the ESP32 Device ID.');
    if (!babyName) return showError('add-incubator-error', "Please enter the baby's name.");
    if (!parentName) return showError('add-incubator-error', "Please enter the parent's name.");

    const submitBtn = $('add-incubator-submit-btn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating...';

    try {
        const childCode = generateChildCode();
        const password = generatePassword();

        const newRef = db.ref('Incubators').push();
        await newRef.set({
            deviceId,
            babyName,
            parentName,
            childCode,
            password,
            createdAt: Date.now(),
            createdBy: currentUser.uid,
            controls: {
                targetTemperature: 37.0,
                photoTherapy: false,
                alarmThreshold: 38.5,
            },
            sensors: {
                temperature: null,
                humidity: null,
                heartRate: null,
                jaundice: 'Low',
                ecg: null,
            }
        });

        // Reset the form fields cleanly
        $('add-incubator-form')?.reset();
        closeAddModal();
        showCredentialsModal(babyName, childCode, password);
    } catch (err) {
        console.error('Add incubator error:', err);
        showError('add-incubator-error', 'Failed to create incubator. Please try again.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-plus"></i> <span>Create Incubator</span>';
    }
});

// ----------------------------------------------------------------
// 18. CREDENTIALS MODAL (shown after incubator creation)
// ----------------------------------------------------------------
function showCredentialsModal(babyName, code, password) {
    $('cred-baby-name').textContent = babyName;
    $('cred-child-code').textContent = code;
    $('cred-password').textContent = password;
    $('credentials-modal')?.classList.remove('hidden');
}

$('credentials-done-btn')?.addEventListener('click', () => {
    $('credentials-modal')?.classList.add('hidden');
});

// Copy buttons in credentials modal
document.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const text = $(targetId)?.textContent ?? '';
        copyToClipboard(text, btn);
    });
});

// ----------------------------------------------------------------
// 19. DOCTOR CONTROLS — TARGET TEMPERATURE
// ----------------------------------------------------------------
const targetInput = $('target-temp-input');
const targetSlider = $('target-temp-slider');

targetInput?.addEventListener('input', () => {
    if (targetSlider) targetSlider.value = targetInput.value;
    updateSliderTrack(targetSlider);
});

targetSlider?.addEventListener('input', () => {
    if (targetInput) targetInput.value = parseFloat(targetSlider.value).toFixed(1);
    updateSliderTrack(targetSlider);
});

function updateSliderTrack(slider) {
    if (!slider) return;
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const val = parseFloat(slider.value);
    const pct = ((val - min) / (max - min)) * 100;
    slider.style.background =
        `linear-gradient(90deg, var(--brand-primary) ${pct}%, var(--bg-surface-2) ${pct}%)`;
}

$('set-target-temp-btn')?.addEventListener('click', async () => {
    if (!selectedIncubatorId) return;
    const val = parseFloat($('target-temp-input')?.value);
    if (isNaN(val) || val < 35 || val > 40) return;

    try {
        await db.ref(`Incubators/${selectedIncubatorId}/controls/targetTemperature`).set(val);
        const feedback = $('temp-feedback');
        feedback?.classList.remove('hidden');
        setTimeout(() => feedback?.classList.add('hidden'), 3000);
    } catch (err) {
        console.error('Set temperature error:', err);
    }
});

// ----------------------------------------------------------------
// 20. DOCTOR CONTROLS — PHOTO THERAPY
// ----------------------------------------------------------------
$('photo-therapy-toggle')?.addEventListener('change', async (e) => {
    if (!selectedIncubatorId) return;
    try {
        await db.ref(`Incubators/${selectedIncubatorId}/controls/photoTherapy`).set(e.target.checked);
    } catch (err) {
        console.error('Photo therapy toggle error:', err);
    }
});

// ----------------------------------------------------------------
// 21. DOCTOR CONTROLS — ALARM THRESHOLD
// ----------------------------------------------------------------
$('set-alarm-btn')?.addEventListener('click', async () => {
    if (!selectedIncubatorId) return;
    const val = parseFloat($('alarm-threshold-input')?.value);
    if (isNaN(val) || val < 35 || val > 42) return;
    alarmThreshold = val;

    try {
        await db.ref(`Incubators/${selectedIncubatorId}/controls/alarmThreshold`).set(val);
    } catch (err) {
        console.error('Set alarm error:', err);
    }
});

// ----------------------------------------------------------------
// 22. PARENT DASHBOARD INITIALIZATION
// ----------------------------------------------------------------
function initParentDashboard(user, profile) {
    const displayName = profile.name || user.displayName || 'Parent';
    $('parent-display-name').textContent = displayName;
    $('parent-display-email').textContent = user.email;
    $('parent-avatar-initials').textContent = getInitials(displayName);

    initDropdown('parent-avatar-btn', 'parent-dropdown');
    $('parent-theme-toggle')?.addEventListener('click', toggleTheme);

    // Show gate (code entry), hide dashboard
    $('parent-code-entry')?.classList.remove('hidden');
    $('parent-dashboard')?.classList.add('hidden');

    // DB connection badge
    db.ref('.info/connected').on('value', (snap) => {
        updateConnectionBadge('parent-connection-status', snap.val() === true);
    });

    // Init parent ECG chart (hidden, initialized for when access is granted)
    ecgChartParent = initECGChart('ecgChartParent');

    setLoading(false);
}

// ----------------------------------------------------------------
// 23. PARENT — ACCESS CODE FORM
// ----------------------------------------------------------------
$('parent-access-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('parent-access-error');

    const code = $('parent-child-code')?.value.trim().toUpperCase();
    const password = $('parent-child-password')?.value.trim();

    if (!code) return showError('parent-access-error', 'Please enter the Child Code.');
    if (!password) return showError('parent-access-error', 'Please enter the Password.');

    const btn = $('parent-access-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Verifying...</span>';

    try {
        // Search all incubators for matching code + password
        const snap = await db.ref('Incubators').get();
        if (!snap.exists()) {
            showError('parent-access-error', 'Invalid Child Code or Password.');
            return;
        }

        let matchedKey = null;
        let matchedData = null;

        snap.forEach(child => {
            const inc = child.val();
            if (inc.childCode === code && String(inc.password) === String(password)) {
                matchedKey = child.key;
                matchedData = inc;
            }
        });

        if (!matchedKey) {
            showError('parent-access-error', 'Invalid Child Code or Password. Please check with your doctor.');
            return;
        }

        // Access granted — show parent dashboard
        showParentMonitor(matchedKey, matchedData);

    } catch (err) {
        console.error('Parent access error:', err);
        showError('parent-access-error', 'An error occurred. Please try again.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-lock-open"></i> <span>Access Dashboard</span>';
    }
});

function showParentMonitor(incubatorId, data) {
    $('parent-code-entry')?.classList.add('hidden');
    const dashboard = $('parent-dashboard');
    dashboard?.classList.remove('hidden');

    $('parent-baby-name').textContent = data.babyName || 'Your Baby';

    // Listen to realtime sensor data for this incubator
    const sensorRef = db.ref(`Incubators/${incubatorId}/sensors`);
    const handler = sensorRef.on('value', (snap) => {
        const d = snap.val();
        if (d) updateSensorUI(d, true);
    });
    activeListeners.push(() => sensorRef.off('value', handler));

    // DB connection state (console only — nav badge removed)
    db.ref('.info/connected').on('value', (snap) => {
        console.log('Firebase connection (parent):', snap.val() === true ? 'online' : 'offline');
    });

    // Start ECG simulation for parent too
    startECGSimulation(incubatorId);
}

// ----------------------------------------------------------------
// 24. CONNECTION BADGE HELPER
// ----------------------------------------------------------------
function updateConnectionBadge(id, online) {
    const badge = $(id);
    if (!badge) return;
    badge.classList.toggle('online', online);
    badge.classList.toggle('offline', !online);
    badge.querySelector('span').textContent = online ? 'Online' : 'Offline';
}

// ----------------------------------------------------------------
// 25. DOM READY — BOOT AUTH UI
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initAuthUI();
    // Initialize slider track fill on load
    updateSliderTrack($('target-temp-slider'));
});

