const firebaseConfig = {
  apiKey: "AIzaSyBUObn49uGiW-FCHn6-ytKwZLrtyIH70GY",
  authDomain: "friendspacedemo.firebaseapp.com",
  projectId: "friendspacedemo",
  storageBucket: "friendspacedemo.firebasestorage.app",
  messagingSenderId: "68848931468",
  appId: "1:68848931468:web:5f1b0aefb35b2c10a261a9",
  measurementId: "G-EXM65Z84F0"
};


// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Enable persistence
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

// ========================================
// GLOBAL STATE
// ========================================
let currentUser = null;
let currentUserMember = null;
let currentSpace = null;
let currentSpaceId = null;
let currentTableId = 'main';
let currentTableData = null;
let messagesListener = null;
let membersListener = null;
let reportsListener = null;
let allMembers = {};
let onlineUsers = new Set();
let reportedMessages = [];
let currentReportData = null;
let currentKickUserId = null;
let currentBanUserId = null;
let lastMessageTime = 0;

let setupData = {
    name: '',
    emoji: '🌟',
    color: '#667eea',
    tables: ['Main'],
    isPublic: true,
    theme: {
        bg: '#ecf0f1',
        text: '#2c3e50'
    }
};

// ========================================
// NOTIFICATIONS
// ========================================
let notificationPermission = false;

async function requestNotificationPermission() {
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            notificationPermission = true;
        } else if (Notification.permission !== 'denied') {
            const permission = await Notification.requestPermission();
            notificationPermission = permission === 'granted';
        }
    }
}

function showNotification(title, body) {
    if (!notificationPermission || !('Notification' in window)) {
        return;
    }
    
    // Show notification regardless of page visibility
    try {
        new Notification(title, {
            body: body,
            icon: '💬',
            badge: '💬',
            tag: 'friendspaces-message'
        });
    } catch (e) {
        console.log('Notification failed:', e);
    }
}

// ========================================
// COOKIE MANAGEMENT
// ========================================
function setCookie(name, value, days) {
    const expires = new Date();
    expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/`;
}

function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

function deleteCookie(name) {
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/`;
}

// ========================================
// ONLINE STATUS MANAGEMENT
// ========================================
let presenceRef = null;
let connectedRef = null;

function setupPresence() {
    if (!currentUser || !currentSpaceId) return;

    // Using Firestore for presence
    const presenceDoc = db.collection('spaces').doc(currentSpaceId)
        .collection('presence').doc(currentUser.uid);

    // Set user as online
    presenceDoc.set({
        online: true,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Update lastSeen every 30 seconds
    presenceRef = setInterval(() => {
        presenceDoc.update({
            online: true,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(err => console.log('Presence update failed:', err));
    }, 30000);

    // Set offline on various events
    const setOffline = () => {
        presenceDoc.set({
            online: false,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(err => console.log('Set offline failed:', err));
    };
    
    // Handle tab close, browser close, navigation away
    window.addEventListener('beforeunload', setOffline);
    window.addEventListener('pagehide', setOffline);
    
    // Handle tab visibility change (tab switch, minimize)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            setOffline();
        } else {
            presenceDoc.set({
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(err => console.log('Set online failed:', err));
        }
    });

    // Listen to all presence
    connectedRef = db.collection('spaces').doc(currentSpaceId)
        .collection('presence')
        .onSnapshot(snapshot => {
            onlineUsers.clear();
            const now = Date.now();
            snapshot.forEach(doc => {
                const data = doc.data();
                // Only consider online if explicitly marked as online AND seen recently
                if (data.online === true && data.lastSeen) {
                    const lastSeen = data.lastSeen.toMillis();
                    // Consider online if seen within last 60 seconds
                    if (now - lastSeen < 60000) {
                        onlineUsers.add(doc.id);
                    }
                }
            });
            updateMemberStatuses();
        });
}

function cleanupPresence() {
    if (presenceRef) {
        clearInterval(presenceRef);
        presenceRef = null;
    }
    if (connectedRef) {
        connectedRef();
        connectedRef = null;
    }
    if (currentUser && currentSpaceId) {
        db.collection('spaces').doc(currentSpaceId)
            .collection('presence').doc(currentUser.uid).set({
                online: false,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(err => console.log('Cleanup presence failed:', err));
    }
}

function updateMemberStatuses() {
    document.querySelectorAll('.member-status').forEach(el => {
        const userId = el.dataset.userId;
        const member = allMembers[userId];
        if (!member) return;

        if (member.status === 'banned') {
            el.textContent = '🚫 Banned';
            el.className = 'member-status status-banned';
        } else if (member.status === 'kicked') {
            el.textContent = '👢 Kicked';
            el.className = 'member-status status-kicked';
        } else if (member.status === 'temp-banned') {
            el.textContent = '⏸️ Temp Banned';
            el.className = 'member-status status-temp-banned';
        } else if (onlineUsers.has(userId)) {
            el.textContent = '🟢 Online';
            el.className = 'member-status status-online';
        } else {
            el.textContent = '⚪ Offline';
            el.className = 'member-status status-offline';
        }
    });
}

// ========================================
// AUTHENTICATION
// ========================================
auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        setCookie('lastUserId', user.uid, 30);
        await checkSpaceSetup();
    } else {
        currentUser = null;
        deleteCookie('lastUserId');
        cleanupPresence();
        document.getElementById('authScreen').style.display = 'flex';
        document.getElementById('appContainer').style.display = 'none';
    }
});

function showSignup() {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('signupForm').classList.remove('hidden');
    document.getElementById('authDescription').textContent = 'Create your account';
}

function showLogin() {
    document.getElementById('signupForm').classList.add('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('authDescription').textContent = 'Sign in to continue';
}

async function signUp() {
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;

    if (!name || !email || !password) {
        showError('Please fill in all fields');
        return;
    }

    if (password.length < 6) {
        showError('Password must be at least 6 characters');
        return;
    }

    try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        await userCredential.user.updateProfile({ displayName: name });
        
    } catch (error) {
        showError(error.message);
    }
}

async function signIn() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) {
        showError('Please fill in all fields');
        return;
    }

    try {
        await auth.signInWithEmailAndPassword(email, password);
        
    } catch (error) {
        showError(error.message);
    }
}

async function logout() {
    cleanupPresence();
    if (messagesListener) messagesListener();
    if (membersListener) membersListener();
    if (reportsListener) reportsListener();
    await auth.signOut();
    
}

async function confirmDeleteAccount() {
    if (!confirm('Are you sure you want to delete your account? This cannot be undone!')) {
        return;
    }

    const password = prompt('Enter your password to confirm:');
    if (!password) return;

    try {
        // Re-authenticate
        const credential = firebase.auth.EmailAuthProvider.credential(
            currentUser.email,
            password
        );
        await currentUser.reauthenticateWithCredential(credential);

        // Delete from all spaces
        const spacesSnapshot = await db.collection('spaces').get();
        for (const spaceDoc of spacesSnapshot.docs) {
            await db.collection('spaces').doc(spaceDoc.id)
                .collection('members').doc(currentUser.uid).delete();
        }

        // Delete user account
        await currentUser.delete();
        
        alert('Account deleted successfully.');
        
    } catch (error) {
        console.error('Error deleting account:', error);
        alert('Error deleting account: ' + error.message);
    }
}

function showError(message) {
    const errorEl = document.getElementById('authError');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    setTimeout(() => {
        errorEl.style.display = 'none';
    }, 5000);
}

// ========================================
// SPACE SETUP
// ========================================
async function checkSpaceSetup() {
    const urlParams = new URLSearchParams(window.location.search);
    currentSpaceId = urlParams.get('space') || window.location.hostname.replace(/\./g, '-');

    // Safety check - make sure user is authenticated
    if (!currentUser) {
        console.error('No authenticated user in checkSpaceSetup');
        document.getElementById('authScreen').style.display = 'flex';
        document.getElementById('appContainer').style.display = 'none';
        document.getElementById('setupWizard').style.display = 'none';
        return;
    }

    try {
        const spaceDoc = await db.collection('spaces').doc(currentSpaceId).get();
        
        if (!spaceDoc.exists) {
            showSetupWizard();
        } else {
            currentSpace = spaceDoc.data();
            
            // Update auth screen logo with space emoji
            const authLogo = document.getElementById('authLogo');
            if (authLogo && currentSpace.icon && currentSpace.icon.emoji) {
                authLogo.textContent = currentSpace.icon.emoji;
            }
            
            const memberDoc = await db.collection('spaces').doc(currentSpaceId)
                .collection('members').doc(currentUser.uid).get();
            
            if (!memberDoc.exists) {
                if (currentSpace.isPublic) {
                    await joinSpace();
                } else {
                    await promptForJoinCode();
                }
            } else {
                currentUserMember = memberDoc.data();
                
                // Check if user is banned
                if (currentUserMember.status === 'banned') {
                    alert('You are banned from this space.');
                    logout();
                    return;
                }
                
                // Check if user was kicked
                if (currentUserMember.status === 'kicked') {
                    showKickedModal();
                    return;
                }
                
                await loadSpace();
            }
        }
    } catch (error) {
        console.error('Error checking space:', error);
        showError('Error loading space: ' + error.message);
    }
}

function showKickedModal() {
    document.getElementById('kickedReason').textContent = currentUserMember.kickReason || 'No reason provided';
    document.getElementById('kickedModal').style.display = 'flex';
}

async function rejoinAfterKick() {
    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(currentUser.uid).update({
                status: 'active',
                kickReason: firebase.firestore.FieldValue.delete()
            });
        
        document.getElementById('kickedModal').style.display = 'none';
        currentUserMember.status = 'active';
        await loadSpace();
        
    } catch (error) {
        console.error('Error rejoining:', error);
        alert('Error rejoining space: ' + error.message);
    }
}

function showSetupWizard() {
    // Hide auth screen, show wizard
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('setupWizard').style.display = 'flex';
    
    initializeEmojiPicker();
    initializeColorPicker();
}

function initializeEmojiPicker() {
    const emojis = [
        // Smileys
        '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇',
        // Hearts & Love
        '🥰','😍','🤩','😘','😗','❤️','🧡','💛','💚','💙','💜','🖤','🤍','💖',
        // Animals
        '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵',
        // Nature
        '🌸','🌺','🌻','🌷','🌹','🌼','🌿','☘️','🍀','🌱','🌲','🌳','🌴','🌵','🌾',
        // Food
        '🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🍍','🥝','🥑','🍔','🍕','🌮',
        // Activities
        '⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🎮','🎯','🎲','🎸','🎹','🎺','🎻',
        // Objects
        '💎','💍','👑','🎩','🎓','⚡','🔥','💧','⭐','🌟','✨','💫','🌙','☀️','🌈',
        // Symbols
        '❤️','💕','💖','💗','💘','💝','💞','💓','💌','💟','❣️','💔','🔴','🟠','🟡'
    ];
    const picker = document.getElementById('emojiPickerSetup');
    picker.innerHTML = '';
    
    emojis.forEach(emoji => {
        const div = document.createElement('div');
        div.className = 'emoji-option';
        div.textContent = emoji;
        if (emoji === setupData.emoji) div.classList.add('selected');
        div.onclick = () => selectEmoji(emoji, div);
        picker.appendChild(div);
    });
    
    // Set up text input listener
    const emojiInput = document.getElementById('emojiInput');
    if (emojiInput) {
        emojiInput.value = setupData.emoji;
        emojiInput.addEventListener('input', (e) => {
            const value = e.target.value;
            if (value) {
                setupData.emoji = value;
                // Deselect all grid options if using custom input
                document.querySelectorAll('.emoji-option').forEach(el => el.classList.remove('selected'));
            }
        });
    }
}

function selectEmoji(emoji, element) {
    setupData.emoji = emoji;
    document.querySelectorAll('.emoji-option').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    
    // Also update the text input
    const emojiInput = document.getElementById('emojiInput');
    if (emojiInput) {
        emojiInput.value = emoji;
    }
}

function initializeColorPicker() {
    const colors = ['#667eea', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#feca57', '#ff6b6b', '#ee5a6f', '#a8e6cf', '#c7ceea', '#ffd3b6', '#ffaaa5'];
    const picker = document.getElementById('colorPicker');
    picker.innerHTML = '';
    
    colors.forEach(color => {
        const div = document.createElement('div');
        div.className = 'color-option';
        div.style.background = color;
        if (color === setupData.color) div.classList.add('selected');
        div.onclick = () => selectColor(color, div);
        picker.appendChild(div);
    });
}

function selectColor(color, element) {
    setupData.color = color;
    document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
}

function addTableToSetup() {
    const tableList = document.getElementById('tableSetupList');
    const div = document.createElement('div');
    div.className = 'table-input-item';
    div.innerHTML = `
        <input type="text" placeholder="Table name">
        <span style="cursor: pointer;" onclick="this.parentElement.remove()">❌</span>
    `;
    tableList.appendChild(div);
}

function nextStep(stepNum) {
    if (stepNum === 2) {
        const name = document.getElementById('spaceName').value.trim();
        if (!name) {
            alert('Please enter a space name');
            return;
        }
        setupData.name = name;
    }

    if (stepNum === 4) {
        const inputs = document.querySelectorAll('#tableSetupList input');
        setupData.tables = Array.from(inputs)
            .map(input => input.value.trim())
            .filter(name => name);
        
        if (setupData.tables.length === 0) {
            setupData.tables = ['Main'];
        }
    }

    if (stepNum === 5) {
        const privacy = document.querySelector('input[name="privacy"]:checked').value;
        setupData.isPublic = privacy === 'public';
    }

    document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
    document.getElementById('step' + stepNum).classList.add('active');
    
}

function prevStep(stepNum) {
    document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
    document.getElementById('step' + stepNum).classList.add('active');
    
}

async function completeSetup() {
    setupData.theme.bg = document.getElementById('themeBg').value;
    setupData.theme.text = document.getElementById('themeText').value;

    let joinCode = '';
    if (!setupData.isPublic) {
        joinCode = generateJoinCode();
    }

    try {
        await db.collection('spaces').doc(currentSpaceId).set({
            name: setupData.name,
            icon: {
                emoji: setupData.emoji,
                color: setupData.color
            },
            isPublic: setupData.isPublic,
            joinCode: joinCode,
            theme: setupData.theme,
            ownerId: currentUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(currentUser.uid).set({
                displayName: currentUser.displayName,
                role: 'owner',
                status: 'active',
                avatarColor: getRandomColor(currentUser.uid),
                joinedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

        for (const tableName of setupData.tables) {
            const tableId = tableName.toLowerCase().replace(/\s+/g, '-');
            await db.collection('spaces').doc(currentSpaceId)
                .collection('tables').doc(tableId).set({
                    name: tableName,
                    canView: ['all'],
                    canSit: ['all'],
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
        }

        if (!setupData.isPublic) {
            document.getElementById('joinCodeDisplay').innerHTML = `
                <p>Your join code:</p>
                <div class="join-code">${joinCode}</div>
                <p style="margin-top: 10px; font-size: 12px; color: #666;">Share this code with your friends!</p>
            `;
        } else {
            document.getElementById('joinCodeDisplay').innerHTML = `
                <p>Your space is public!</p>
                <p style="margin-top: 10px; font-size: 12px; color: #666;">Anyone can join by visiting this URL.</p>
            `;
        }

        nextStep(6);
        
    } catch (error) {
        console.error('Error creating space:', error);
        alert('Error creating space: ' + error.message);
    }
}

function generateJoinCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < 10; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

async function promptForJoinCode() {
    document.getElementById('joinCodeModal').style.display = 'flex';
}

async function submitJoinCode() {
    const code = document.getElementById('joinCodeInput').value.trim();
    
    if (!code) {
        document.getElementById('joinCodeError').textContent = 'Please enter a join code';
        document.getElementById('joinCodeError').style.display = 'block';
        return;
    }

    if (code !== currentSpace.joinCode) {
        document.getElementById('joinCodeError').textContent = 'Invalid join code';
        document.getElementById('joinCodeError').style.display = 'block';
        return;
    }

    document.getElementById('joinCodeModal').style.display = 'none';
    await joinSpace();
    
}

function cancelJoinCode() {
    document.getElementById('joinCodeModal').style.display = 'none';
    logout();
}

async function joinSpace() {
    try {
        // Check if space is full (50 members max)
        const membersSnapshot = await db.collection('spaces').doc(currentSpaceId)
            .collection('members').get();
        
        if (membersSnapshot.size >= 50) {
            alert('This space is full (50 members maximum).');
            logout();
            return;
        }

        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(currentUser.uid).set({
                displayName: currentUser.displayName,
                role: 'guest',
                status: 'active',
                avatarColor: getRandomColor(currentUser.uid),
                joinedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

        const memberDoc = await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(currentUser.uid).get();
        currentUserMember = memberDoc.data();

        await loadSpace();
    } catch (error) {
        console.error('Error joining space:', error);
        alert('Error joining space: ' + error.message);
    }
}

async function enterSpace() {
    try {
        // Load the member data first
        const memberDoc = await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(currentUser.uid).get();
        
        if (memberDoc.exists) {
            currentUserMember = memberDoc.data();
        } else {
            throw new Error('Member data not found');
        }
        
        document.getElementById('setupWizard').style.display = 'none';
        await loadSpace();
        
    } catch (error) {
        console.error('Error entering space:', error);
        alert('Error entering space: ' + error.message);
    }
}


// ========================================
// LOAD SPACE
// ========================================
async function loadSpace() {
    try {
        // Safety check - ensure we have member data
        if (!currentUserMember) {
            const memberDoc = await db.collection('spaces').doc(currentSpaceId)
                .collection('members').doc(currentUser.uid).get();
            
            if (!memberDoc.exists) {
                throw new Error('You are not a member of this space');
            }
            
            currentUserMember = memberDoc.data();
        }
        
        const spaceDoc = await db.collection('spaces').doc(currentSpaceId).get();
        currentSpace = spaceDoc.data();

        if (currentSpace.theme) {
            const chatArea = document.querySelector('.chat-area');
            const messagesContainer = document.querySelector('.messages-container');
            const inputArea = document.querySelector('.message-input-area');
            
            chatArea.style.background = currentSpace.theme.bg;
            messagesContainer.style.background = currentSpace.theme.bg;
            messagesContainer.style.color = currentSpace.theme.text;
            inputArea.style.background = currentSpace.theme.bg;
            
            // Apply to all message text
            document.documentElement.style.setProperty('--message-text-color', currentSpace.theme.text);
            document.documentElement.style.setProperty('--message-author-color', currentSpace.theme.text);
            document.documentElement.style.setProperty('--chat-bg-color', currentSpace.theme.bg);
        }

        document.getElementById('headerSpaceName').textContent = currentSpace.name;
        const iconEl = document.getElementById('headerSpaceIcon');
        iconEl.textContent = currentSpace.icon.emoji;
        iconEl.style.background = currentSpace.icon.color;

        const userAvatar = document.getElementById('userAvatar');
        userAvatar.textContent = currentUser.displayName.charAt(0).toUpperCase();
        
        // Ensure avatar color exists and store if needed
        const avatarColor = await ensureAvatarColor(currentUser.uid);
        userAvatar.style.background = avatarColor;

        document.getElementById('userName').textContent = currentUser.displayName;
        
        if (currentUserMember.role !== 'friend' && currentUserMember.role !== 'guest') {
            document.getElementById('userRoleBadge').textContent = currentUserMember.role;
            document.getElementById('userRoleBadge').style.display = 'inline';
        }

        // Show moderator button for co-owners and owners
        if (isOwnerOrCoOwner()) {
            document.getElementById('moderatorBtn').style.display = 'inline-block';
        }

        await loadMembers();
        await loadTables();
        setupPresence();
        setupReportsListener();
        
        // Request notification permission
        await requestNotificationPermission();

        document.getElementById('authScreen').style.display = 'none';
        document.getElementById('setupWizard').style.display = 'none';
        document.getElementById('appContainer').style.display = 'flex';

        loadMessages('main');
    } catch (error) {
        console.error('Error loading space:', error);
        alert('Error loading space: ' + error.message);
    }
}

async function loadMembers() {
    if (membersListener) membersListener();
    
    membersListener = db.collection('spaces').doc(currentSpaceId)
        .collection('members')
        .onSnapshot(snapshot => {
            allMembers = {};
            snapshot.forEach(doc => {
                allMembers[doc.id] = { id: doc.id, ...doc.data() };
            });
            updateMemberStatuses();
        });
}

async function loadTables() {
    const tablesSnapshot = await db.collection('spaces').doc(currentSpaceId)
        .collection('tables').orderBy('createdAt').get();

    const tablesList = document.getElementById('tablesList');
    tablesList.innerHTML = '';

    tablesSnapshot.forEach(doc => {
        const table = doc.data();
        const div = document.createElement('div');
        div.className = 'table-item';
        if (doc.id === currentTableId) div.classList.add('active');
        
        const canManage = isOwnerOrCoOwner();
        const shieldHtml = canManage ? `<span class="table-shield" onclick="event.stopPropagation(); openTablePermissions('${doc.id}', '${escapeHtml(table.name)}')">🛡️</span>` : '';
        
        // Add delete button for non-main tables if user is owner/co-owner
        const canDelete = canManage && doc.id !== 'main';
        const deleteHtml = canDelete ? `<span class="table-delete" onclick="event.stopPropagation(); deleteTable('${doc.id}', '${escapeHtml(table.name)}')">✕</span>` : '';
        
        div.innerHTML = `
            <span class="table-name" onclick="switchTable('${doc.id}')">${escapeHtml(table.name)}</span>
            <span class="table-actions">
                ${shieldHtml}
                ${deleteHtml}
            </span>
        `;
        tablesList.appendChild(div);
    });

    if (isOwnerOrCoOwner()) {
        const addSection = document.createElement('div');
        addSection.className = 'add-table-section';
        addSection.innerHTML = `
            <input type="text" class="new-table-input" id="newTableInput" placeholder="New table name..." onkeypress="handleNewTableKeyPress(event)">
            <button class="btn btn-small" onclick="createNewTable()">+ Add Table</button>
        `;
        tablesList.appendChild(addSection);
    }
}

async function createNewTable() {
    const input = document.getElementById('newTableInput');
    const tableName = input.value.trim();
    
    if (!tableName) return;

    const tableId = tableName.toLowerCase().replace(/\s+/g, '-');

    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('tables').doc(tableId).set({
                name: tableName,
                canView: ['all'],
                canSit: ['all'],
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

        input.value = '';
        await loadTables();
        
    } catch (error) {
        console.error('Error creating table:', error);
        alert('Error creating table: ' + error.message);
    }
}

async function deleteTable(tableId, tableName) {
    if (!confirm(`Are you sure you want to delete the table "${tableName}"? All messages in this table will be permanently deleted.`)) {
        return;
    }

    try {
        // Delete the table document
        await db.collection('spaces').doc(currentSpaceId)
            .collection('tables').doc(tableId).delete();

        // If we're currently viewing this table, switch to main
        if (currentTableId === tableId) {
            switchTable('main');
        }

        // Reload tables list
        await loadTables();
    } catch (error) {
        console.error('Error deleting table:', error);
        alert('Error deleting table: ' + error.message);
    }
}

function handleNewTableKeyPress(event) {
    if (event.key === 'Enter') {
        createNewTable();
    }
}

function switchTable(tableId) {
    currentTableId = tableId;
    
    document.querySelectorAll('.table-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`[onclick="switchTable('${tableId}')"]`).closest('.table-item').classList.add('active');

    db.collection('spaces').doc(currentSpaceId)
        .collection('tables').doc(tableId).get()
        .then(doc => {
            currentTableData = doc.data();
            document.getElementById('headerTableName').textContent = currentTableData.name;
            loadMessages(tableId);
        });
    
    
}

// ========================================
// MESSAGES
// ========================================
function loadMessages(tableId) {
    if (messagesListener) messagesListener();

    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    db.collection('spaces').doc(currentSpaceId)
        .collection('tables').doc(tableId).get()
        .then(doc => {
            currentTableData = doc.data();
            updateMessageInput();
        });

    messagesListener = db.collection('spaces').doc(currentSpaceId)
        .collection('tables').doc(tableId)
        .collection('messages')
        .orderBy('timestamp', 'asc')
        .limit(100)
        .onSnapshot(snapshot => {
            messagesContainer.innerHTML = '';
            
            if (snapshot.empty) {
                messagesContainer.innerHTML = '<div class="loading">No messages yet. Start the conversation!</div>';
            } else {
                snapshot.forEach(doc => {
                    const msg = { id: doc.id, ...doc.data() };
                    renderMessage(msg);
                });
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                
                // Show notification for new messages
                if (snapshot.docChanges().length > 0) {
                    const lastChange = snapshot.docChanges()[snapshot.docChanges().length - 1];
                    if (lastChange.type === 'added' && lastChange.doc.data().senderId !== currentUser.uid) {
                        const msgData = lastChange.doc.data();
                        showNotification('New message from ' + msgData.senderName, msgData.text.substring(0, 50));
                        
                    }
                }
            }
        }, error => {
            console.error('Error loading messages:', error);
            messagesContainer.innerHTML = '<div class="loading">Error loading messages</div>';
        });
}

function updateMessageInput() {
    const inputArea = document.getElementById('messageInputArea');
    
    if (currentUserMember.status === 'temp-banned' || !canSitAtTable(currentTableData)) {
        inputArea.innerHTML = '<div class="no-send-permission">You cannot send messages in this table.</div>';
    } else {
        inputArea.innerHTML = `
            <div class="message-input-container">
                <textarea id="messageInput" placeholder="Type a message..." onkeydown="handleMessageKeyDown(event)" rows="1"></textarea>
                <button class="emoji-btn" onclick="toggleEmojiPicker()">😊</button>
                <button class="send-btn" onclick="sendMessage()">Send</button>
            </div>
            <div class="emoji-picker" id="emojiPicker" style="display: none;"></div>
        `;
        
        // Auto-resize textarea as user types
        const textarea = document.getElementById('messageInput');
        if (textarea) {
            textarea.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });
        }
    }
}

function canSitAtTable(tableData) {
    if (!tableData) return false;
    if (tableData.canSit.includes('all')) return true;
    if (tableData.canSit.includes(currentUserMember.role)) return true;
    if (tableData.canSit.includes(currentUser.uid)) return true;
    return false;
}

function renderMessage(msg) {
    const messagesContainer = document.getElementById('messagesContainer');
    const div = document.createElement('div');
    div.className = 'message';
    div.dataset.messageId = msg.id;
    div.dataset.senderId = msg.senderId;
    
    // Check if message is hidden (user temp-banned)
    if (msg.hidden) {
        div.classList.add('hidden-message');
    }

    const avatarColor = msg.avatarColor || getRandomColor(msg.senderId);
    const initial = msg.senderName.charAt(0).toUpperCase();
    const timestamp = msg.timestamp ? new Date(msg.timestamp.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    const rankBadge = msg.senderRole && msg.senderRole !== 'friend' && msg.senderRole !== 'guest' ? 
        `<span class="message-rank">${msg.senderRole}</span>` : '';

    // Extract image link if present (any image URL with common extensions)
    let messageText = msg.text;
    let imageHtml = '';
    // Match URLs containing image extensions anywhere in the path
    const imageRegex = /(https?:\/\/[^\s]+\/[^\s]*\.(?:jpg|jpeg|png|gif|webp|bmp)(?:[^\s]*)?)/i;
    const imageMatch = messageText.match(imageRegex);
    
    if (imageMatch) {
        const imageUrl = imageMatch[1];
        
        imageHtml = `
            <div class="image-preview" onclick="window.open('${escapeHtml(imageUrl)}', '_blank')">
                <img src="${escapeHtml(imageUrl)}" alt="Image" onerror="this.parentElement.style.display='none'">
            </div>
        `;
        
        // Remove image link from text
        messageText = messageText.replace(imageRegex, '').trim();
    }

    // Make links clickable
    messageText = linkify(messageText);
    
    // Report icon (only show for other users' messages and if user is co-owner/owner)
    const reportIcon = msg.senderId !== currentUser.uid && isOwnerOrCoOwner() ? 
        `<span class="report-icon" onclick="openReportModal('${msg.id}', '${escapeHtml(msg.senderName)}', '${escapeHtml(msg.text)}')">🚨</span>` : '';

    div.innerHTML = `
        ${reportIcon}
        <div class="message-avatar" style="background: ${avatarColor}">${initial}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-author">${escapeHtml(msg.senderName)}</span>
                ${rankBadge}
                <span class="message-time">${timestamp}</span>
            </div>
            ${imageHtml}
            ${messageText ? `<div class="message-text">${messageText}</div>` : ''}
        </div>
    `;

    messagesContainer.appendChild(div);
}

function linkify(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return escapeHtml(text).replace(urlRegex, (url) => {
        return `<a href="${url}" target="_blank">${url}</a>`;
    });
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) return;

    // 1-second cooldown to prevent spam
    const now = Date.now();
    if (now - lastMessageTime < 1000) {
        alert('Please wait a moment before sending another message.');
        return;
    }
    lastMessageTime = now;

    // Ensure avatar color exists
    const avatarColor = await ensureAvatarColor(currentUser.uid);

    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('tables').doc(currentTableId)
            .collection('messages').add({
                text: text,
                senderId: currentUser.uid,
                senderName: currentUser.displayName,
                senderRole: currentUserMember.role,
                avatarColor: avatarColor,
                hidden: false,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

        input.value = '';
        closeEmojiPicker();
        
    } catch (error) {
        console.error('Error sending message:', error);
        alert('Error sending message: ' + error.message);
    }
}

function handleMessageKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

// ========================================
// EMOJI PICKER
// ========================================
function toggleEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (!picker) return;
    
    if (picker.style.display === 'none') {
        showEmojiPicker();
    } else {
        closeEmojiPicker();
    }
}

function showEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (!picker) return;
    
    const emojis = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','☺️','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊','💋','💌','💘','💝','💖','💗','💓','💞','💕','💟','❣️','💔','❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💯','💢','💥','💫','💦','💨','🕳️','💣','💬','👁️‍🗨️','🗨️','🗯️','💭','💤','👋','🤚','🖐️','✋','🖖','👌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🦷','🦴','👀','👁️','👅','👄'];
    
    picker.innerHTML = '';
    emojis.forEach(emoji => {
        const span = document.createElement('span');
        span.textContent = emoji;
        span.onclick = () => insertEmoji(emoji);
        picker.appendChild(span);
    });
    
    picker.style.display = 'grid';
    
}

function closeEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (picker) {
        picker.style.display = 'none';
    }
}

function insertEmoji(emoji) {
    const input = document.getElementById('messageInput');
    if (!input) return;
    
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = input.value;
    
    input.value = text.substring(0, start) + emoji + text.substring(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + emoji.length;
}

// Close emoji picker when clicking outside
document.addEventListener('click', (e) => {
    const picker = document.getElementById('emojiPicker');
    const emojiBtn = document.querySelector('.emoji-btn');
    
    if (picker && picker.style.display !== 'none' && 
        !picker.contains(e.target) && 
        e.target !== emojiBtn) {
        closeEmojiPicker();
    }
});

// ========================================
// REPORTING SYSTEM
// ========================================
function setupReportsListener() {
    if (!isOwnerOrCoOwner()) return;
    
    if (reportsListener) reportsListener();
    
    reportsListener = db.collection('spaces').doc(currentSpaceId)
        .collection('reports')
        .where('resolved', '==', false)
        .onSnapshot(snapshot => {
            reportedMessages = [];
            snapshot.forEach(doc => {
                reportedMessages.push({ id: doc.id, ...doc.data() });
            });
            
            // Update badge
            const badge = document.getElementById('reportBadge');
            if (reportedMessages.length > 0) {
                badge.textContent = reportedMessages.length;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        });
}

function openReportModal(messageId, userName, messageText) {
    currentReportData = { messageId, userName, messageText };
    document.getElementById('reportConfirmText').innerHTML = `
        Do you really want to report <strong>${escapeHtml(userName)}</strong> with message:<br>
        "<em>${escapeHtml(messageText.substring(0, 100))}</em>"?
    `;
    document.getElementById('reportModal').style.display = 'flex';
}

function closeReportModal() {
    document.getElementById('reportModal').style.display = 'none';
    currentReportData = null;
}

async function confirmReport() {
    if (!currentReportData) return;
    
    try {
        // Get the message data
        const messageDoc = await db.collection('spaces').doc(currentSpaceId)
            .collection('tables').doc(currentTableId)
            .collection('messages').doc(currentReportData.messageId).get();
        
        if (!messageDoc.exists) {
            alert('Message not found');
            return;
        }
        
        const msgData = messageDoc.data();
        
        // Hide all messages from this user in this table
        const userMessagesSnapshot = await db.collection('spaces').doc(currentSpaceId)
            .collection('tables').doc(currentTableId)
            .collection('messages')
            .where('senderId', '==', msgData.senderId)
            .get();
        
        const batch = db.batch();
        userMessagesSnapshot.docs.forEach(doc => {
            batch.update(doc.ref, { hidden: true });
        });
        await batch.commit();
        
        // Temp-ban the user
        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(msgData.senderId).update({
                status: 'temp-banned'
            });
        
        // Create report
        await db.collection('spaces').doc(currentSpaceId)
            .collection('reports').add({
                messageId: currentReportData.messageId,
                messageText: msgData.text,
                reportedUserId: msgData.senderId,
                reportedUserName: msgData.senderName,
                reportedBy: currentUser.uid,
                tableId: currentTableId,
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                resolved: false
            });
        
        closeReportModal();
        
        alert('User reported and temp-banned. Check Moderator panel to resolve.');
    } catch (error) {
        console.error('Error reporting:', error);
        alert('Error reporting message: ' + error.message);
    }
}

// ========================================
// MODERATOR PANEL
// ========================================
function openModerator() {
    const reportsList = document.getElementById('reportedMessagesList');
    reportsList.innerHTML = '';
    
    if (reportedMessages.length === 0) {
        reportsList.innerHTML = '<p style="text-align: center; color: #999;">No reported messages</p>';
    } else {
        reportedMessages.forEach(report => {
            const div = document.createElement('div');
            div.className = 'reported-message-item';
            
            const timestamp = report.timestamp ? new Date(report.timestamp.toDate()).toLocaleString() : '';
            
            div.innerHTML = `
                <div class="reported-message-header">
                    <span class="reported-user">${escapeHtml(report.reportedUserName)}</span>
                    <span class="reported-time">${timestamp}</span>
                </div>
                <div class="reported-message-text">${escapeHtml(report.messageText)}</div>
                <div class="moderation-actions">
                    <button class="mod-action-btn mod-approve" onclick="resolveReport('${report.id}', 'approve', '${report.reportedUserId}')" title="Approve - Restore messages">👍</button>
                    <button class="mod-action-btn mod-kick" onclick="resolveReport('${report.id}', 'kick', '${report.reportedUserId}', '${escapeHtml(report.messageText)}')" title="Kick user">🦶</button>
                    <button class="mod-action-btn mod-ban" onclick="resolveReport('${report.id}', 'ban', '${report.reportedUserId}')" title="Ban user">💥</button>
                </div>
            `;
            
            reportsList.appendChild(div);
        });
    }
    
    document.getElementById('moderatorModal').style.display = 'flex';
    
}

function closeModerator() {
    document.getElementById('moderatorModal').style.display = 'none';
}

async function resolveReport(reportId, action, userId, kickMessage = '') {
    try {
        const report = reportedMessages.find(r => r.id === reportId);
        if (!report) return;
        
        if (action === 'approve') {
            // Restore messages
            const messagesSnapshot = await db.collection('spaces').doc(currentSpaceId)
                .collection('tables').doc(report.tableId)
                .collection('messages')
                .where('senderId', '==', userId)
                .where('hidden', '==', true)
                .get();
            
            const batch = db.batch();
            messagesSnapshot.docs.forEach(doc => {
                batch.update(doc.ref, { hidden: false });
            });
            await batch.commit();
            
            // Remove temp-ban
            await db.collection('spaces').doc(currentSpaceId)
                .collection('members').doc(userId).update({
                    status: 'active'
                });
            
        } else if (action === 'kick') {
            await kickUserInternal(userId, kickMessage || report.messageText);
        } else if (action === 'ban') {
            await banUserInternal(userId);
        }
        
        // Mark report as resolved
        await db.collection('spaces').doc(currentSpaceId)
            .collection('reports').doc(reportId).update({
                resolved: true,
                resolvedBy: currentUser.uid,
                resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
                action: action
            });
        
        
    } catch (error) {
        console.error('Error resolving report:', error);
        alert('Error resolving report: ' + error.message);
    }
}

// ========================================
// KICK & BAN SYSTEM
// ========================================
function openKickModal(userId) {
    currentKickUserId = userId;
    const member = allMembers[userId];
    document.getElementById('kickUserName').textContent = member.displayName;
    document.getElementById('kickReason').value = '';
    document.getElementById('kickModal').style.display = 'flex';
}

function closeKickModal() {
    document.getElementById('kickModal').style.display = 'none';
    currentKickUserId = null;
}

async function confirmKick() {
    const reason = document.getElementById('kickReason').value.trim();
    if (!reason) {
        alert('Please provide a reason for kicking');
        return;
    }
    
    await kickUserInternal(currentKickUserId, reason);
    closeKickModal();
    
}

async function kickUserInternal(userId, reason) {
    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(userId).update({
                status: 'kicked',
                kickReason: reason
            });
        
        // Note: Firebase doesn't provide a way to sign out users from all devices
        // The kicked user will see the kicked modal on their next page load
        
        alert('User kicked successfully');
    } catch (error) {
        console.error('Error kicking user:', error);
        alert('Error kicking user: ' + error.message);
    }
}

function openBanModal(userId) {
    currentBanUserId = userId;
    const member = allMembers[userId];
    document.getElementById('banUserName').textContent = member.displayName;
    document.getElementById('banModal').style.display = 'flex';
}

function closeBanModal() {
    document.getElementById('banModal').style.display = 'none';
    currentBanUserId = null;
}

async function confirmBan() {
    await banUserInternal(currentBanUserId);
    closeBanModal();
    
}

async function banUserInternal(userId) {
    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(userId).update({
                status: 'banned',
                kickReason: firebase.firestore.FieldValue.delete()
            });
        
        alert('User banned successfully');
        
        // Refresh settings to show unban button
        openSettings();
    } catch (error) {
        console.error('Error banning user:', error);
        alert('Error banning user: ' + error.message);
    }
}

async function unbanUser(userId) {
    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(userId).update({
                status: 'active'
            });
        
        
        alert('User unbanned successfully');
        openSettings(); // Refresh settings
    } catch (error) {
        console.error('Error unbanning user:', error);
        alert('Error unbanning user: ' + error.message);
    }
}

// ========================================
// TABLE PERMISSIONS
// ========================================
let currentPermissionTableId = null;

async function openTablePermissions(tableId, tableName) {
    currentPermissionTableId = tableId;
    document.getElementById('modalTableName').textContent = tableName;

    const tableDoc = await db.collection('spaces').doc(currentSpaceId)
        .collection('tables').doc(tableId).get();
    const tableData = tableDoc.data();

    const canViewList = document.getElementById('canViewList');
    const canSitList = document.getElementById('canSitList');
    
    canViewList.innerHTML = '';
    canSitList.innerHTML = '';

    const allOption = createPermissionCheckbox('all', 'Everyone', tableData.canView.includes('all'), tableData.canSit.includes('all'));
    canViewList.appendChild(allOption.view);
    canSitList.appendChild(allOption.sit);

    const roles = ['owner', 'co-owner', 'super-friend', 'friend', 'guest'];
    roles.forEach(role => {
        const roleOption = createPermissionCheckbox(role, role, tableData.canView.includes(role), tableData.canSit.includes(role));
        canViewList.appendChild(roleOption.view);
        canSitList.appendChild(roleOption.sit);
    });

    document.getElementById('tablePermissionsModal').style.display = 'flex';
    
}

function createPermissionCheckbox(id, label, canView, canSit) {
    const viewDiv = document.createElement('div');
    viewDiv.className = 'checkbox-item';
    viewDiv.innerHTML = `
        <input type="checkbox" id="view-${id}" ${canView ? 'checked' : ''}>
        <label for="view-${id}">${label}</label>
    `;

    const sitDiv = document.createElement('div');
    sitDiv.className = 'checkbox-item';
    sitDiv.innerHTML = `
        <input type="checkbox" id="sit-${id}" ${canSit ? 'checked' : ''}>
        <label for="sit-${id}">${label}</label>
    `;

    return { view: viewDiv, sit: sitDiv };
}

async function saveTablePermissions() {
    const canView = [];
    const canSit = [];

    document.querySelectorAll('#canViewList input[type="checkbox"]:checked').forEach(cb => {
        const id = cb.id.replace('view-', '');
        canView.push(id);
    });

    document.querySelectorAll('#canSitList input[type="checkbox"]:checked').forEach(cb => {
        const id = cb.id.replace('sit-', '');
        canSit.push(id);
    });

    if (canView.length === 0) canView.push('all');
    if (canSit.length === 0) canSit.push('all');

    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('tables').doc(currentPermissionTableId)
            .update({ canView, canSit });

        closeTablePermissions();
        
        if (currentTableId === currentPermissionTableId) {
            const tableDoc = await db.collection('spaces').doc(currentSpaceId)
                .collection('tables').doc(currentTableId).get();
            currentTableData = tableDoc.data();
            updateMessageInput();
        }
        
        
    } catch (error) {
        console.error('Error saving permissions:', error);
        alert('Error saving permissions: ' + error.message);
    }
}

function closeTablePermissions() {
    document.getElementById('tablePermissionsModal').style.display = 'none';
    currentPermissionTableId = null;
}

// ========================================
// SETTINGS
// ========================================
async function openSettings() {
    const membersList = document.getElementById('membersList');
    membersList.innerHTML = '';

    // Update member count
    const memberCount = Object.keys(allMembers).length;
    document.getElementById('memberCount').textContent = memberCount;

    // Update space info
    document.getElementById('settingsSpaceName').textContent = currentSpace.name;
    document.getElementById('settingsSpaceType').textContent = currentSpace.isPublic ? 'Public' : 'Private';
    
    if (!currentSpace.isPublic) {
        document.getElementById('settingsJoinCodeContainer').classList.remove('hidden');
        document.getElementById('settingsJoinCodeValue').textContent = currentSpace.joinCode;
    } else {
        document.getElementById('settingsJoinCodeContainer').classList.add('hidden');
    }

    Object.values(allMembers).forEach(member => {
        const div = document.createElement('div');
        div.className = 'member-item';

        const avatarColor = member.avatarColor || getRandomColor(member.id);
        const initial = member.displayName.charAt(0).toUpperCase();
        
        const canChangeRole = isOwnerOrCoOwner() && member.id !== currentUser.uid;
        const canKickBan = isOwnerOrCoOwner() && member.id !== currentUser.uid && member.role !== 'owner';
        
        let roleControl = '';
        if (canChangeRole) {
            roleControl = `
                <select class="role-select" onchange="changeUserRole('${member.id}', this.value)">
                    <option value="guest" ${member.role === 'guest' ? 'selected' : ''}>Guest</option>
                    <option value="friend" ${member.role === 'friend' ? 'selected' : ''}>Friend</option>
                    <option value="super-friend" ${member.role === 'super-friend' ? 'selected' : ''}>Super Friend</option>
                    <option value="co-owner" ${member.role === 'co-owner' ? 'selected' : ''}>Co-owner</option>
                    ${isOwner() ? `<option value="owner" ${member.role === 'owner' ? 'selected' : ''}>Owner</option>` : ''}
                </select>
            `;
        } else {
            roleControl = `<div style="font-size: 13px; color: #7f8c8d;">${member.role}</div>`;
        }
        
        let actionButtons = '';
        if (canKickBan) {
            if (member.status === 'banned') {
                actionButtons = `<button class="action-btn unban-btn" onclick="unbanUser('${member.id}')">Unban</button>`;
            } else if (member.status !== 'kicked') {
                actionButtons = `
                    <button class="action-btn kick-btn" onclick="openKickModal('${member.id}')">Kick</button>
                    <button class="action-btn ban-btn" onclick="openBanModal('${member.id}')">Ban</button>
                `;
            }
        }

        div.innerHTML = `
            <div class="member-avatar" style="background: ${avatarColor}">${initial}</div>
            <div class="member-details">
                <div class="member-name">${escapeHtml(member.displayName)}</div>
                <div class="member-status" data-user-id="${member.id}"></div>
            </div>
            <div class="member-controls">
                ${roleControl}
                ${actionButtons}
            </div>
        `;
        
        membersList.appendChild(div);
    });
    
    updateMemberStatuses();

    const settingsDeleteBtn = document.getElementById('settingsDeleteBtn');
    if (isOwner()) {
        settingsDeleteBtn.style.display = 'block';
    } else {
        settingsDeleteBtn.style.display = 'none';
    }

    document.getElementById('settingsModal').style.display = 'flex';
    
}

async function changeUserRole(userId, newRole) {
    try {
        await db.collection('spaces').doc(currentSpaceId)
            .collection('members').doc(userId).update({ role: newRole });
        
    } catch (error) {
        console.error('Error changing role:', error);
        alert('Error changing role: ' + error.message);
    }
}

async function deleteSpace() {
    if (!confirm('Are you ABSOLUTELY SURE you want to delete this space? This cannot be undone!')) {
        return;
    }

    const confirmText = prompt('Type the space name to confirm deletion:');
    if (confirmText !== currentSpace.name) {
        alert('Space name does not match. Deletion cancelled.');
        return;
    }

    try {
        // Delete all subcollections (members, tables, messages, reports, presence)
        const batch = db.batch();
        
        // This is a simplified deletion - in production you'd want Cloud Functions for this
        await db.collection('spaces').doc(currentSpaceId).delete();
        
        alert('Space deleted successfully.');
        logout();
        
    } catch (error) {
        console.error('Error deleting space:', error);
        alert('Error deleting space: ' + error.message);
    }
}

function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

// ========================================
// UTILITIES
// ========================================
async function ensureAvatarColor(userId) {
    // Check if current user member has avatarColor
    if (currentUserMember && !currentUserMember.avatarColor) {
        const newColor = getRandomColor(userId);
        currentUserMember.avatarColor = newColor;
        
        // Store in Firestore
        try {
            await db.collection('spaces').doc(currentSpaceId)
                .collection('members').doc(userId).update({
                    avatarColor: newColor
                });
        } catch (error) {
            console.error('Error storing avatar color:', error);
        }
        
        return newColor;
    }
    return currentUserMember.avatarColor || getRandomColor(userId);
}

function isOwner() {
    return currentUserMember && currentUserMember.role === 'owner';
}

function isOwnerOrCoOwner() {
    return currentUserMember && (currentUserMember.role === 'owner' || currentUserMember.role === 'co-owner');
}

function getRandomColor(seed) {
    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========================================
// INITIALIZATION
// ========================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('FriendSpaces loaded successfully!');
});
