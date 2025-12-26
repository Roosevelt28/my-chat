// ელემენტების აღება
const themeToggle = document.getElementById('themeToggle');
const body = document.body;
const chatWindow = document.getElementById('chatWindow');
const messageInput = document.getElementById('messageInput');

// 1. დღის და ღამის რეჟიმი
themeToggle.addEventListener('click', () => {
    body.classList.toggle('dark-mode');
    const icon = themeToggle.querySelector('i');
    if (body.classList.contains('dark-mode')) {
        icon.classList.remove('fa-moon');
        icon.classList.add('fa-sun');
    } else {
        icon.classList.remove('fa-sun');
        icon.classList.add('fa-moon');
    }
});

// 2. სექციების გადართვა (ნავიგაცია)
function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active', 'hidden'));
    document.getElementById(sectionId).classList.add('active');
}

// 3. რეგისტრაციის სიმულაცია
let currentUser = {
    name: "სტუმარი",
    purpose: "",
    photo: "https://via.placeholder.com/150"
};

function registerUser() {
    const name = document.getElementById('regName').value;
    const purpose = document.getElementById('regPurpose').value;
    const dob = document.getElementById('regDob').value;

    if (name) {
        currentUser.name = name;
        currentUser.purpose = purpose;
        
        // მონაცემების ასახვა პროფილში
        document.getElementById('displayName').textContent = name;
        const purposeText = {
            'coffee': '☕ ყავის დალევა',
            'dating': '❤️ დაოჯახება',
            'hangout': '🎉 დროის გაყვანა'
        };
        document.getElementById('displayPurpose').textContent = purposeText[purpose];
        document.getElementById('displayDate').textContent = "რეგისტრირებულია: " + new Date().toLocaleDateString();

        // გადაყვანა პროფილზე
        document.getElementById('authSection').classList.add('hidden');
        showSection('profileSection');
    } else {
        alert("გთხოვთ შეიყვანოთ სახელი");
    }
}

// 4. ფოტოს ატვირთვის სიმულაცია (ბრაუზერში)
function uploadProfilePhoto(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('profilePic').src = e.target.result;
            // ფოტოს დამატება გალერეაშიც
            addToGallery(e.target.result);
        }
        reader.readAsDataURL(file);
    }
}

function addToGallery(imgSrc) {
    const gallery = document.getElementById('galleryGrid');
    const img = document.createElement('img');
    img.src = imgSrc;
    img.className = 'gallery-img';
    gallery.appendChild(img);
}

// 5. ჩატის ფუნქციები (სქროლი + Enter)
messageInput.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

function sendMessage() {
    const text = messageInput.value;
    if (text.trim() === "") return;

    // მესიჯის დამატება
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', 'my-message');
    
    // დროის დამატება
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    msgDiv.innerHTML = `${text} <span style="font-size:0.7em; opacity:0.7; float:right; margin-left:5px;">${time}</span>`;
    
    // წაშლის ფუნქცია (ორჯერ დაწკაპუნებით)
    msgDiv.addEventListener('dblclick', function() {
        if(confirm("წავშალოთ მესიჯი?")) {
            this.remove();
        }
    });

    chatWindow.appendChild(msgDiv);
    messageInput.value = "";

    // სქროლის გასწორება (ავტომატურად ჩასვლა)
    chatWindow.scrollTop = chatWindow.scrollHeight;

    // სიმულაცია: პასუხი 1 წამში
    setTimeout(() => {
        const replyDiv = document.createElement('div');
        replyDiv.classList.add('message', 'other-message');
        replyDiv.innerHTML = `გამარჯობა ${currentUser.name}, როგორ ხარ? 😊 <div style="margin-top:5px;">❤️ 👍 😆</div>`;
        chatWindow.appendChild(replyDiv);
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }, 1000);
}
