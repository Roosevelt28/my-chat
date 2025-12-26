// ელემენტების ინიციალიზაცია
const loginOverlay = document.getElementById('loginOverlay');
const mainApp = document.getElementById('mainApp');
const chatArea = document.getElementById('chatArea');
const msgInput = document.getElementById('msgInput');

// 1. შემოწმება: დარეგისტრირებულია თუ არა მომხმარებელი?
window.onload = function() {
    const savedUser = localStorage.getItem('chatUser_data');
    if (savedUser) {
        loadUser(JSON.parse(savedUser));
    } else {
        loginOverlay.style.display = 'flex';
    }
    loadMessages();
};

// 2. რეგისტრაცია
function completeRegistration() {
    const name = document.getElementById('regName').value;
    const dob = document.getElementById('regDob').value;
    const purpose = document.getElementById('regPurpose').value;

    if (!name || !purpose) {
        alert("შეავსეთ სახელი და აირჩიეთ მიზანი!");
        return;
    }

    const userData = {
        name: name,
        dob: dob,
        purpose: purpose,
        avatar: `https://ui-avatars.com/api/?name=${name}&background=00d26a&color=fff`,
        joined: new Date().toLocaleDateString()
    };

    localStorage.setItem('chatUser_data', JSON.stringify(userData));
    loadUser(userData);
}

// 3. მომხმარებლის ჩატვირთვა
function loadUser(user) {
    loginOverlay.style.display = 'none';
    mainApp.classList.remove('hidden');

    // ჰედერი
    document.getElementById('headerName').textContent = user.name;
    document.getElementById('headerAvatar').src = user.avatar;

    // პროფილი
    document.getElementById('profileName').textContent = user.name;
    document.getElementById('profileBigImg').src = user.avatar;
    
    // მიზნის ტექსტი
    const purposes = { 'coffee': '☕ ყავა & საუბარი', 'dating': '❤️ დაოჯახება', 'chill': '🕶️ დროის გაყვანა' };
    document.getElementById('profilePurpose').textContent = purposes[user.purpose] || user.purpose;
    
    // ასაკის გამოთვლა
    if(user.dob) {
        const age = new Date().getFullYear() - new Date(user.dob).getFullYear();
        document.getElementById('profileDob').textContent = `ასაკი: ${age} წლის`;
    }

    // გალერეის ჩატვირთვა
    loadGallery();
}

// 4. ჩატის ფუნქციები
msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMsg();
});

function sendMsg() {
    const text = msgInput.value.trim();
    if (!text) return;

    saveMessage(text, 'me');
    msgInput.value = '';
    
    // ავტო-პასუხი (სიმულაცია)
    setTimeout(() => {
        const replies = ["გასაგებია...", "კარგი აზრია! 👍", "ჰაჰა, მართლა? 😄", "მოიცა, ახლა დაკავებული ვარ...", "ok"];
        const randomReply = replies[Math.floor(Math.random() * replies.length)];
        saveMessage(randomReply, 'other');
    }, 1500);
}

function saveMessage(text, type) {
    const msgs = JSON.parse(localStorage.getItem('chat_history') || '[]');
    const newMsg = { text, type, time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) };
    msgs.push(newMsg);
    localStorage.setItem('chat_history', JSON.stringify(msgs));
    renderMessage(newMsg);
}

function loadMessages() {
    chatArea.innerHTML = '';
    const msgs = JSON.parse(localStorage.getItem('chat_history') || '[]');
    msgs.forEach(msg => renderMessage(msg));
}

function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.type === 'me' ? 'msg-me' : 'msg-other'}`;
    div.innerHTML = `${msg.text} <span class="msg-time">${msg.time}</span>`;
    
    // წაშლა ორჯერ კლიკით
    div.addEventListener('dblclick', function(){
        if(confirm('წავშალოთ?')) {
            this.remove();
            // რეალურ პროექტში აქ localStorage-დანაც უნდა წაიშალოს
        }
    });

    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
}

function clearChat() {
    if(confirm('ნამდვილად გინდათ ჩატის გასუფთავება?')) {
        localStorage.removeItem('chat_history');
        chatArea.innerHTML = '';
    }
}

// 5. პროფილის და გალერეის ფუნქციები
function toggleProfile() {
    document.getElementById('profileSidebar').classList.toggle('open');
}

function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const imgData = e.target.result;
            
            // შევინახოთ გალერეაში
            const gallery = JSON.parse(localStorage.getItem('user_gallery') || '[]');
            gallery.push(imgData);
            localStorage.setItem('user_gallery', JSON.stringify(gallery));
            
            // ეკრანზე გამოჩენა
            addImgToGrid(imgData);
            
            // მთავარ ფოტოდ დაყენება
            document.getElementById('profileBigImg').src = imgData;
            document.getElementById('headerAvatar').src = imgData;
            
            // User მონაცემების განახლება
            let userData = JSON.parse(localStorage.getItem('chatUser_data'));
            userData.avatar = imgData;
            localStorage.setItem('chatUser_data', JSON.stringify(userData));
        }
        reader.readAsDataURL(file);
    }
}

function loadGallery() {
    const grid = document.getElementById('userGallery');
    grid.innerHTML = '';
    const gallery = JSON.parse(localStorage.getItem('user_gallery') || '[]');
    gallery.forEach(img => addImgToGrid(img));
}

function addImgToGrid(src) {
    const img = document.createElement('img');
    img.src = src;
    document.getElementById('userGallery').appendChild(img);
}

function logout() {
    if(confirm('გასვლა?')) {
        localStorage.removeItem('chatUser_data');
        location.reload();
    }
}
