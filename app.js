// ================================================================
// Team 3 — Smart Infant Incubator System
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
let currentDashboardState = null;
let activeListeners = [];         // Firebase listener unsubscribe refs
let ecgChart = null;       // Chart.js instance (Doctor)
let ecgChartParent = null;       // Chart.js instance (Parent)
let ecgBuffer = [];         // Rolling ECG values
const ECG_BUFFER_SIZE = 80;

// ── Frontend Peak Detection & BPM State ──────────────────────────
const SAMPLE_INTERVAL_MS = 20;       // 1000ms / 50 samples
const PEAK_HIGH_THRESHOLD = 2600;    // raw ADC value to trigger a peak
const PEAK_LOW_THRESHOLD = 2350;    // raw ADC value to exit refractory
const BPM_BUFFER_SIZE = 5;
let bpmBuffer = [75, 75, 75, 75, 75]; // moving-average seed
let peakRefractory = false;           // true while waiting for signal to drop
let sampleIndex = 0;                  // monotonic sample counter (for elapsed-time calc)
let lastPeakSampleIndex = -1;         // sampleIndex of the previous detected peak

const deviceLastSeen = {};
const previousSensorData = {};
const previousLastUpdate = {};
const isInitialLoad = {};

setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.sidebar-item').forEach(item => {
        const id = item.dataset.id;
        if (!id) return;

        const age = now - (deviceLastSeen[id] || 0);
        const dot = item.querySelector('.sidebar-item-online');

        if (age > 5000) {
            // OFFLINE

            // CRITICAL: If selected, force dashboard offline
            if (id === selectedIncubatorId && currentDashboardState !== 'offline') {
                currentDashboardState = 'offline';
                const statusBadge = $('patient-status-badge');
                if (statusBadge) {
                    statusBadge.classList.add('status-offline');
                    statusBadge.innerHTML = '<i class="fa-solid fa-link-slash"></i><span>Device Offline</span>';
                }
                const ecgBadge = $('ecg-live-badge');
                if (ecgBadge) {
                    ecgBadge.classList.add('status-offline');
                    ecgBadge.innerHTML = '<i class="fa-solid fa-circle"></i> OFFLINE';
                }
                const text = $('last-updated-text');
                if (text) text.textContent = 'No data \u2014 device offline';
                const badge = $('last-updated-badge');
                if (badge) {
                    badge.classList.remove('fresh');
                    badge.classList.add('stale');
                }

                ['temp-val', 'hum-val', 'hr-val', 'jaundice-val'].forEach(elId => {
                    const el = $(elId); if (el) el.textContent = '--';
                });
                ['temp-progress', 'hum-progress', 'hr-progress'].forEach(elId => {
                    const el = $(elId); if (el) el.style.width = '0%';
                });

                if (ecgChart && ecgChart.data.datasets[0].data.some(v => v !== 0)) {
                    ecgChart.data.datasets[0].data.fill(0);
                    ecgChart.update('none');
                }
            }
        } else {
            // ONLINE

            if (id === selectedIncubatorId && currentDashboardState !== 'online') {
                currentDashboardState = 'online';
                const statusBadge = $('patient-status-badge');
                if (statusBadge) {
                    statusBadge.classList.remove('status-offline');
                    statusBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>Live Monitoring</span>';
                }
                const ecgBadge = $('ecg-live-badge');
                if (ecgBadge) {
                    ecgBadge.classList.remove('status-offline');
                    ecgBadge.innerHTML = '<i class="fa-solid fa-circle"></i> LIVE';
                }

                // Force UI Sync on Reconnection
                if (previousSensorData[id]) {
                    try {
                        const data = JSON.parse(previousSensorData[id]);
                        const isParent = currentUserRole === 'parent';
                        updateSensorUI(data, isParent);
                        updateLastUpdated();
                    } catch (e) { }
                }
            }
        }
    });
}, 1000);

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
const THEME_KEY = 'Team 3_theme';

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

        const now = Date.now();
        Object.keys(data).forEach(id => {
            const inc = data[id];
            if (inc && inc.sensors) {
                const incomingTimestamp = inc.sensors.lastUpdate;

                // Only mark as "seen now" if the timestamp is actually new/different
                if (incomingTimestamp && incomingTimestamp !== previousLastUpdate[id]) {
                    deviceLastSeen[id] = Date.now();
                    previousLastUpdate[id] = incomingTimestamp;

                    // If this is the active incubator, update UI immediately
                    if (selectedIncubatorId === id) {
                        const isParent = currentUserRole === 'parent';
                        updateSensorUI(inc.sensors, isParent);
                        updateLastUpdated();

                        // ECG — array of up to 50 raw samples
                        const ecgRaw = inc.sensors.ecg;
                        const ecgArray = Array.isArray(ecgRaw)
                            ? ecgRaw
                            : (ecgRaw !== null && ecgRaw !== undefined ? [ecgRaw] : []);

                        for (let si = 0; si < ecgArray.length; si++) {
                            const rawValue = ecgArray[si];
                            const voltage = (rawValue / 4095.0) * 3.3;

                            if (ecgChart) pushECGSample(ecgChart, voltage);
                            if (ecgChartParent) pushECGSample(ecgChartParent, voltage);

                            // ── Peak detection ─────────────────────────────────
                            sampleIndex++;

                            if (!peakRefractory && rawValue > PEAK_HIGH_THRESHOLD) {
                                // Peak detected
                                peakRefractory = true;

                                if (lastPeakSampleIndex >= 0) {
                                    const timeDiffMs = (sampleIndex - lastPeakSampleIndex) * SAMPLE_INTERVAL_MS;

                                    if (timeDiffMs >= 300 && timeDiffMs <= 1500) {
                                        const instantBPM = Math.round(60000 / timeDiffMs);

                                        // Update moving-average buffer
                                        bpmBuffer.push(instantBPM);
                                        if (bpmBuffer.length > BPM_BUFFER_SIZE) bpmBuffer.shift();

                                        const smoothedBPM = Math.round(
                                            bpmBuffer.reduce((a, b) => a + b, 0) / bpmBuffer.length
                                        );

                                        // Update HR UI elements
                                        ['hr-val', 'p-hr-val'].forEach(id => {
                                            const el = $(id);
                                            if (el) el.textContent = smoothedBPM;
                                        });
                                        const hrProgress = $('hr-progress');
                                        if (hrProgress) hrProgress.style.width = clamp((smoothedBPM - 80) / 120 * 100, 0, 100) + '%';
                                        const pHrProgress = $('p-hr-progress');
                                        if (pHrProgress) pHrProgress.style.width = clamp((smoothedBPM - 80) / 120 * 100, 0, 100) + '%';
                                    }
                                }
                                lastPeakSampleIndex = sampleIndex;

                            } else if (peakRefractory && rawValue < PEAK_LOW_THRESHOLD) {
                                // Signal dropped low — exit refractory
                                peakRefractory = false;
                            }
                        }
                    }
                }
                // Sync the raw string for recovery purposes
                previousSensorData[id] = JSON.stringify(inc.sensors);
            }
        });
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
        const isOnline = inc?.status?.online === true;
        const item = document.createElement('div');
        item.className = 'sidebar-item' + (key === selectedIncubatorId ? ' active' : '');
        item.setAttribute('role', 'listitem');
        item.setAttribute('data-id', key);

        const genderClass = inc.gender === 'girl' ? 'gender-girl-icon' : (inc.gender === 'boy' ? 'gender-boy-icon' : '');

        item.innerHTML = `
            <div class="sidebar-item-avatar ${genderClass}">
                <i class="fa-solid fa-baby"></i>
            </div>
            <div class="sidebar-item-info">
                <div class="sidebar-item-name">${escapeHtml(inc.babyName || 'Unnamed')}</div>
                <div class="sidebar-item-sub">${escapeHtml(inc.parentName || '\u2014')}</div>
            </div>
            <div class="sidebar-item-online"></div>`;

        item.addEventListener('click', () => {
            selectIncubator(key, inc);
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

/** Helper: reset all badge + sensor fields to a neutral "Connecting…" state.
 *  The Firebase presence listener is the authoritative source of truth
 *  and will immediately update these to Live or Offline on first reply. */
function resetDashboardUI() {
    clearTimeout(lastUpdateTimer);

    // Last-updated badge → neutral
    const badge = $('last-updated-badge');
    const text = $('last-updated-text');
    if (badge) badge.classList.remove('fresh', 'stale');
    if (text) text.textContent = 'Connecting...';

    // Patient status badge → "Connecting" spinner (neutral, no red)
    const statusBadge = $('patient-status-badge');
    if (statusBadge) {
        statusBadge.classList.remove('status-offline');
        statusBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Connecting...</span>';
    }

    // ECG badge → neutral connecting
    const ecgBadge = $('ecg-live-badge');
    if (ecgBadge) {
        ecgBadge.classList.remove('status-offline');
        ecgBadge.innerHTML = '<i class="fa-solid fa-circle"></i> Connecting';
    }

    // All sensor values → --
    ['temp-val', 'hum-val', 'hr-val', 'jaundice-val'].forEach(id => {
        const el = $(id);
        if (el) el.textContent = '--';
    });
    ['temp-progress', 'hum-progress', 'hr-progress'].forEach(id => {
        const el = $(id);
        if (el) el.style.width = '0%';
    });
}

/** Removed setSidebarDotOffline globally */

function selectIncubator(id, data) {
    selectedIncubatorId = id;

    // Update sidebar active state
    document.querySelectorAll('.sidebar-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === id);
    });

    // Show the dashboard panel
    $('no-incubator-selected')?.classList.add('hidden');
    $('incubator-dashboard')?.classList.remove('hidden');

    // Populate patient header
    $('dashboard-baby-name').textContent = data.babyName || 'Unknown';
    $('dashboard-parent-name').textContent = data.parentName || '—';
    $('dashboard-child-code').textContent = data.childCode || '—';
    $('dashboard-device-id').textContent = data.deviceId || '—';

    // Apply gender class to patient-avatar
    const avatar = document.querySelector('#incubator-dashboard .patient-avatar');
    if (avatar) {
        avatar.className = 'patient-avatar'; // reset
        if (data.gender === 'girl') avatar.classList.add('gender-girl-icon');
        else if (data.gender === 'boy') avatar.classList.add('gender-boy-icon');
    }

    // Set UI to "Connecting…", clear ECG waveform
    if (typeof hideAlert === 'function') hideAlert('alert-banner');
    resetDashboardUI();
    currentDashboardState = 'connecting';

    // Reset frontend peak-detection state for the new incubator
    peakRefractory = false;
    sampleIndex = 0;
    lastPeakSampleIndex = -1;
    bpmBuffer = [75, 75, 75, 75, 75];
    if (ecgChart) {
        ecgChart.data.datasets[0].data = Array(ECG_BUFFER_SIZE).fill(0);
        ecgChart.update('none');
    }

    // Initial Selection Logic - OFFLINE check
    const age = Date.now() - (deviceLastSeen[id] || 0);
    if (age > 5000) {
        const statusBadge = $('patient-status-badge');
        if (statusBadge) {
            statusBadge.classList.add('status-offline');
            statusBadge.innerHTML = '<i class="fa-solid fa-link-slash"></i><span>Device Offline</span>';
        }
        const ecgBadge = $('ecg-live-badge');
        if (ecgBadge) {
            ecgBadge.classList.add('status-offline');
            ecgBadge.innerHTML = '<i class="fa-solid fa-circle"></i> Offline';
        }
        const text = $('last-updated-text');
        if (text) text.textContent = 'No data \u2014 device offline';
        const badge = $('last-updated-badge');
        if (badge) {
            badge.classList.remove('fresh');
            badge.classList.add('stale');
        }

        ['temp-val', 'hum-val', 'hr-val', 'jaundice-val'].forEach(elId => {
            const el = $(elId); if (el) el.textContent = '--';
        });
        ['temp-progress', 'hum-progress', 'hr-progress'].forEach(elId => {
            const el = $(elId); if (el) el.style.width = '0%';
        });
    }

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
// ----------------------------------------------------------------
// 14. REALTIME SENSOR DATA (Handled Globally)
// ----------------------------------------------------------------

const BILIRUBIN_SLOPE = 15.0;
const BILIRUBIN_OFFSET = 0.5;

function calculateBilirubin(r, g, b) {
    const safeB = b === 0 ? 1 : b;
    const safeG = g === 0 ? 1 : g;
    const bi = Math.log10(255 / safeB) - Math.log10(255 / safeG);
    return (bi * BILIRUBIN_SLOPE) + BILIRUBIN_OFFSET;
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

    // Heart Rate — now calculated on the frontend via peak detection.
    // The value is updated directly in listenToIncubatorList; no Firebase read needed here.

    // Jaundice
    if (data.r !== undefined && data.g !== undefined && data.b !== undefined) {
        const bilirubin = calculateBilirubin(data.r, data.g, data.b);
        updateJaundiceUI(bilirubin, isParent);
    } else if (data.jaundice !== undefined) {
        updateJaundiceUI(data.jaundice, isParent);
    }
}

function updateJaundiceUI(level, isParent) {
    const prefix = isParent ? 'p-' : '';
    const valEl = $(`${prefix}jaundice-val`);
    const indEl = isParent ? $('p-jaundice-indicator') : $('jaundice-indicator');
    const dotEl = indEl?.querySelector('.jaundice-dot');
    const textEl = $(`${prefix}jaundice-level-text`);

    let label, dotClass, color, displayVal;

    if (typeof level === 'number') {
        displayVal = level.toFixed(1) + ' mg/dL';
        if (level < 5.0) {
            label = 'Low'; dotClass = ''; color = 'var(--color-success)';
        } else if (level <= 15.0) {
            label = 'Medium'; dotClass = 'medium'; color = 'var(--color-warning)';
        } else {
            label = 'High'; dotClass = 'high'; color = 'var(--color-danger)';
        }
    } else {
        const levelStr = String(level).toLowerCase();
        if (levelStr === 'low' || levelStr === '0') {
            label = 'Low'; dotClass = ''; color = 'var(--color-success)';
        } else if (levelStr === 'medium' || levelStr === '1') {
            label = 'Medium'; dotClass = 'medium'; color = 'var(--color-warning)';
        } else {
            label = 'High'; dotClass = 'high'; color = 'var(--color-danger)';
        }
        displayVal = label;
    }

    if (valEl) { valEl.textContent = displayVal; valEl.style.color = color; }
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

    // After 2.5 seconds without a new update → Device Stale
    clearTimeout(lastUpdateTimer);
    lastUpdateTimer = setTimeout(() => {
        badge.classList.remove('fresh');
        badge.classList.add('stale');
    }, 2500);
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
                    min: -0.2,
                    max: 3.5,
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

// ECG is handled exclusively inside the Firebase sensors onValue listener (see listenToSensorData).
// No local simulation or setInterval — the chart only updates when real data arrives from Firebase.

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

// Gender selection logic
document.querySelectorAll('.gender-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('active'));
        const targetBtn = e.currentTarget;
        targetBtn.classList.add('active');
        const genderInput = $('new-baby-gender');
        if (genderInput) genderInput.value = targetBtn.dataset.gender;
    });
});

$('add-incubator-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('add-incubator-error');

    const deviceId = $('esp-device-id')?.value.trim();
    const babyName = $('new-baby-name')?.value.trim();
    const parentName = $('new-parent-name')?.value.trim();
    const gender = $('new-baby-gender')?.value;

    if (!deviceId) return showError('add-incubator-error', 'Please enter the ESP32 Device ID.');
    if (!babyName) return showError('add-incubator-error', "Please enter the baby's name.");
    if (!parentName) return showError('add-incubator-error', "Please enter the parent's name.");
    if (!gender) return showError('add-incubator-error', 'Please select the baby\'s gender (Boy/Girl).');

    const submitBtn = $('add-incubator-submit-btn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating...';

    try {
        const childCode = generateChildCode();
        const password = generatePassword();

        const newRef = db.ref(`Incubators/${deviceId}`);
        await newRef.set({
            deviceId,
            babyName,
            parentName,
            gender,
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
// 21b. DOCTOR CONTROLS — DELETE INCUBATOR
// ----------------------------------------------------------------
$('delete-incubator-btn')?.addEventListener('click', async () => {
    if (!selectedIncubatorId) return;
    const confirmed = confirm(
        'Are you sure you want to delete this incubator and all its data? This action cannot be undone.'
    );
    if (!confirmed) return;

    try {
        await db.ref('Incubators/' + selectedIncubatorId).remove();
        // Reset UI
        clearSensorListeners();
        clearTimeout(lastUpdateTimer);
        selectedIncubatorId = null;
        $('incubator-dashboard')?.classList.add('hidden');
        $('no-incubator-selected')?.classList.remove('hidden');
    } catch (err) {
        console.error('Delete incubator error:', err);
        alert('Failed to delete incubator. Please try again.');
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

    // Apply gender class to patient-avatar
    const avatar = document.querySelector('#parent-dashboard .patient-avatar');
    if (avatar) {
        avatar.className = 'patient-avatar'; // reset
        if (data.gender === 'girl') avatar.classList.add('gender-girl-icon');
        else if (data.gender === 'boy') avatar.classList.add('gender-boy-icon');
    }

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
// Flatpickr global initialization
let startPicker, endPicker;

document.addEventListener('DOMContentLoaded', () => {
    initAuthUI();
    // Initialize slider track fill on load
    updateSliderTrack($('target-temp-slider'));

    startPicker = flatpickr("#history-start", {
        enableTime: true,
        dateFormat: "Y-m-d H:i",
        time_24hr: true
    });

    endPicker = flatpickr("#history-end", {
        enableTime: true,
        dateFormat: "Y-m-d H:i",
        time_24hr: true
    });
});

// ----------------------------------------------------------------
// 26. HISTORICAL DATA MODAL
// ----------------------------------------------------------------
let historyCharts = {};
let targetIncubatorHistory = null;
let currentHistoryFilter = '1H';

function getJaundiceNumeric(d) {
    if (d && d.r !== undefined && d.g !== undefined && d.b !== undefined) {
        return calculateBilirubin(d.r, d.g, d.b);
    }
    const val = d ? d.jaundice : null;
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;

    const s = String(val).toLowerCase();
    if (s === 'low' || s === '0') return 2.0;
    if (s === 'medium' || s === '1') return 10.0;
    if (s === 'high' || s === '2') return 15.0;
    return parseFloat(val) || 0;
}

function initHistoryCharts() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        elements: {
            line: { tension: 0, borderWidth: 2 },
            point: { radius: 0, hitRadius: 10, hoverRadius: 4 }
        },
        scales: {
            x: {
                type: 'time',
                time: {
                    tooltipFormat: 'yyyy-MM-dd HH:mm:ss'
                },
                ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }
            },
            y: { beginAtZero: false } // Will be customized per chart
        },
        plugins: { legend: { display: false } },
        interaction: { mode: 'index', intersect: false }
    };

    const configs = [
        { id: 'historyTempChart', color: '#f97316', key: 'temperature' },
        { id: 'historyHumChart', color: '#3b82f6', key: 'humidity' },
        { id: 'historyHRChart', color: '#ef4444', key: 'heartRate' },
        { id: 'historyJaundiceChart', color: '#eab308', key: 'jaundice' },
        { id: 'historyEcgChart', color: '#2563eb', key: 'ecg' } // ECG shouldn't have points, tension 0
    ];

    configs.forEach(conf => {
        const ctx = $(conf.id);
        if (!ctx) return;
        if (historyCharts[conf.key]) {
            historyCharts[conf.key].destroy();
        }
        historyCharts[conf.key] = new Chart(ctx, {
            type: 'line',
            data: { datasets: [{ data: [], borderColor: conf.color, backgroundColor: conf.color + '33', fill: conf.key !== 'ecg' }] },
            options: commonOptions
        });
    });
}

async function fetchHistoryAndRender(incubatorId) {
    if (!incubatorId) return;
    targetIncubatorHistory = incubatorId;

    const modal = $('history-modal');
    if (modal) modal.classList.remove('hidden');

    applyHistoryFilter(currentHistoryFilter);
}

async function applyHistoryFilter(filter) {
    currentHistoryFilter = filter;
    if (!targetIncubatorHistory) return;

    const btns = document.querySelectorAll('.history-toolbar .btn-filter');
    btns.forEach(b => b.classList.remove('active'));
    if (filter === '1H' && btns[0]) btns[0].classList.add('active');
    else if (filter === '24H' && btns[1]) btns[1].classList.add('active');
    else if (filter === '7D' && btns[2]) btns[2].classList.add('active');
    else if (filter === '30D' && btns[3]) btns[3].classList.add('active');
    else if (filter === 'ALL' && btns[4]) btns[4].classList.add('active');
    else if (filter === 'CUSTOM' && btns[5]) btns[5].classList.add('active');

    const loadingEl = $('history-loading');
    const emptyEl = $('history-empty');
    const containerEl = $('history-charts-container');

    if (loadingEl) loadingEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
    if (containerEl) containerEl.style.display = 'none';

    const now = Date.now();
    let startTime = 0;
    let endTime = now;

    if (filter === '1H') startTime = now - 3600000;
    else if (filter === '24H') startTime = now - 86400000;
    else if (filter === '7D') startTime = now - 604800000;
    else if (filter === '30D') startTime = now - 2592000000;
    else if (filter === 'CUSTOM') {
        const s = startPicker ? startPicker.selectedDates[0] : null;
        const e = endPicker ? endPicker.selectedDates[0] : null;
        if (s) startTime = s.getTime();
        if (e) endTime = e.getTime();
    }
    else if (filter === 'ALL') {
        startTime = 0;
    }

    try {
        let ref = db.ref(`History/${targetIncubatorHistory}`).orderByKey();
        if (startTime > 0) {
            ref = ref.startAt(startTime.toString());
        }
        if (filter === 'CUSTOM' && endTime > 0) {
            ref = ref.endAt(endTime.toString());
        }

        const snap = await ref.once('value');
        const rawData = snap.val();

        if (!rawData) {
            if (loadingEl) loadingEl.classList.add('hidden');
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }

        const keys = Object.keys(rawData).sort((a, b) => Number(a) - Number(b));

        initHistoryCharts();

        let parsedData = { temperature: [], humidity: [], heartRate: [], jaundice: [], ecg: [] };
        let lastTs = null;

        const total = keys.length;
        let processed = 0;

        for (let i = 0; i < total; i++) {
            const ts = Number(keys[i]);
            const d = rawData[keys[i]];

            if (lastTs !== null && (ts - lastTs) > 10000) {
                const dropTs1 = lastTs + 1;
                parsedData.temperature.push({ x: dropTs1, y: 0 });
                parsedData.humidity.push({ x: dropTs1, y: 0 });
                parsedData.heartRate.push({ x: dropTs1, y: 0 });
                parsedData.jaundice.push({ x: dropTs1, y: 0 });
                parsedData.ecg.push({ x: dropTs1, y: 0 });

                const dropTs2 = ts - 1;
                parsedData.temperature.push({ x: dropTs2, y: 0 });
                parsedData.humidity.push({ x: dropTs2, y: 0 });
                parsedData.heartRate.push({ x: dropTs2, y: 0 });
                parsedData.jaundice.push({ x: dropTs2, y: 0 });
                parsedData.ecg.push({ x: dropTs2, y: 0 });
            }

            parsedData.temperature.push({ x: ts, y: parseFloat(d.temperature) || 0 });
            parsedData.humidity.push({ x: ts, y: parseFloat(d.humidity) || 0 });
            parsedData.heartRate.push({ x: ts, y: parseFloat(d.heartRate) || 0 });
            parsedData.jaundice.push({ x: ts, y: getJaundiceNumeric(d) });
            // ECG may now arrive as an array; use the first sample to represent the second
            const rawEcgVal = Array.isArray(d.ecg) ? d.ecg[0] : d.ecg;
            parsedData.ecg.push({ x: ts, y: ((parseFloat(rawEcgVal) || 0) / 4095.0) * 3.3 });

            lastTs = ts;
            processed++;

            if (processed % 250 === 0) {
                const prog = $('history-progress-bar');
                if (prog) prog.style.width = (processed / total * 100) + '%';
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // [FUTURE: Insert Data Analysis / AI Predictions Here]

        historyCharts['temperature'].data.datasets[0].data = parsedData.temperature;
        historyCharts['humidity'].data.datasets[0].data = parsedData.humidity;
        historyCharts['heartRate'].data.datasets[0].data = parsedData.heartRate;
        historyCharts['jaundice'].data.datasets[0].data = parsedData.jaundice;
        historyCharts['ecg'].data.datasets[0].data = parsedData.ecg;

        Object.values(historyCharts).forEach(c => c.update('none'));

        if (loadingEl) loadingEl.classList.add('hidden');
        if (containerEl) containerEl.style.display = 'grid';

    } catch (e) {
        console.error("Error fetching history:", e);
        if (loadingEl) loadingEl.classList.add('hidden');
        if (emptyEl) emptyEl.classList.remove('hidden');
    }
}
