const chatBox = document.getElementById("chat-messages");
const inputField = document.getElementById("user-input");
const fileInput = document.getElementById("screenshot");
const sendBtn = document.getElementById("send-btn");

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

  if (userText) appendMessage(userText, "user");

  inputField.value = "";
  fileInput.value = null;

  const formData = new FormData();
  if (userText) formData.append("message", userText);
  if (file) formData.append("screenshot", file);
  if (threadId) formData.append("thread_id", threadId);

  const thinkingId = `thinking-${Date.now()}`;
  appendMessage("Thinking...", "bot");
  const lastBot = document.querySelector(".bot-message:last-child");
  lastBot.setAttribute("data-id", thinkingId);

  try {
    const res = await fetch("/api/chat", { method: "POST", body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    threadId = data.thread_id;
    sessionStorage.setItem("thread_id", threadId);

    // replace the "Thinking..." bubble
    const bubble = document.querySelector(`.bot-message[data-id="${thinkingId}"]`);
    if (bubble) bubble.remove();

    appendMessage(data.reply || "No reply.", "bot");
  } catch (err) {
    console.error("Error:", err);
    const bubble = document.querySelector(`.bot-message[data-id="${thinkingId}"]`);
    if (bubble) bubble.remove();
    appendMessage("Something went wrong. Please try again.", "bot");
  }
}

sendBtn.addEventListener("click", sendMessage);
inputField.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

