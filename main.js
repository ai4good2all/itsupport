// src/main.js

const chatBox = document.getElementById("chat-messages");
const inputField = document.getElementById("user-input");
const fileInput = document.getElementById("screenshot");

let threadId = sessionStorage.getItem("thread_id") || null;

function appendMessage(text, sender = "bot") {
  const msg = document.createElement("div");
  msg.className = `message ${sender}-message`;
  msg.textContent = text;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function sendMessage() {
  const userText = inputField.value.trim();
  const file = fileInput.files[0];

  if (!userText && !file) return;

  appendMessage(userText, "user");
  inputField.value = "";
  fileInput.value = null;

  const formData = new FormData();
  formData.append("message", userText);
  if (file) formData.append("screenshot", file);
  if (threadId) formData.append("thread_id", threadId);

  appendMessage("Thinking...", "bot");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    threadId = data.thread_id;
    sessionStorage.setItem("thread_id", threadId);

    document.querySelector(".bot-message:last-child").remove();
    appendMessage(data.reply, "bot");
  } catch (err) {
    console.error("Error:", err);
    appendMessage("Something went wrong.", "bot");
  }
}
