const chatBox = document.getElementById("chat-messages");
const inputField = document.getElementById("user-input");
const fileInput = document.getElementById("screenshot");
const fileLabel = document.getElementById("file-label");
const sendBtn = document.getElementById("send-btn");

// Thread persistence - MS
let threadId = sessionStorage.getItem("thread_id") || null;

// Initialize
function init() {
  // Add file input change listener
  if (fileInput) {
    fileInput.addEventListener('change', handleFileSelection);
  }
  
  // Add event listeners
  if (sendBtn) {
    sendBtn.addEventListener("click", sendMessage);
  }
  
  if (inputField) {
    inputField.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    
    // Auto-focus input
    inputField.focus();
  }
}

function handleFileSelection() {
  const file = fileInput.files[0];
  if (file && fileLabel) {
    fileLabel.textContent = `📷 ${file.name}`;
    fileLabel.classList.add('file-selected');
  } else if (fileLabel) {
    fileLabel.textContent = '📷 Upload Screenshot';
    fileLabel.classList.remove('file-selected');
  }
}

function appendMessage(text, sender = "bot", isError = false) {
  if (!chatBox) return null;
  
  const msg = document.createElement("div");
  msg.className = `message ${sender}-message${isError ? ' error-message' : ''}`;
  msg.textContent = text;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msg;
}

function showStatus(text) {
  if (!chatBox) return null;
  
  const status = document.createElement("div");
  status.className = "status-indicator";
  status.textContent = text;
  chatBox.appendChild(status);
  chatBox.scrollTop = chatBox.scrollHeight;
  return status;
}

function setLoading(loading) {
  if (sendBtn) {
    sendBtn.disabled = loading;
    sendBtn.textContent = loading ? "..." : "Send";
  }
  if (inputField) {
    inputField.disabled = loading;
  }
  if (fileInput) {
    fileInput.disabled = loading;
  }
}

async function sendMessage() {
  try {
    // Check if elements exist
    if (!inputField || !chatBox) {
      console.error("Required DOM elements not found");
      return;
    }

    const userText = inputField.value.trim();
    const file = fileInput ? fileInput.files[0] : null;

    // Validate input
    if (!userText && !file) {
      appendMessage("Please enter a message or upload a screenshot.", "bot", true);
      return;
    }

    // Show user message
    if (userText) {
      appendMessage(userText, "user");
    }
    
    if (file) {
      appendMessage(`📷 Uploaded: ${file.name}`, "user");
    }

    // Clear inputs
    inputField.value = "";
    if (fileInput) {
      fileInput.value = "";
    }
    if (fileLabel) {
      fileLabel.textContent = '📷 Upload Screenshot';
      fileLabel.classList.remove('file-selected');
    }

    // Show loading state
    setLoading(true);
    const thinkingMsg = appendMessage("🤔 Analyzing your issue...", "bot");
    if (thinkingMsg) {
      thinkingMsg.classList.add('thinking');
    }

    try {
      // Prepare form data
      const formData = new FormData();
      if (userText) {
        formData.append("message", userText);
      }
      if (file) {
        formData.append("screenshot", file);
      }
      if (threadId) {
        formData.append("thread_id", threadId);
      }

      console.log("Sending request to /api/chat");

      // Send request - using relative path
      const response = await fetch("/api/chat", {
        method: "POST",
        body: formData,
      });

      console.log("Response status:", response.status);

      if (!response.ok) {
        let errorMessage = `Server error (${response.status})`;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch (e) {
          // If we can't parse JSON, use the status text
          errorMessage = response.statusText || errorMessage;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      console.log("Response data:", data);

      // Update thread ID
      if (data.thread_id) {
        threadId = data.thread_id;
        sessionStorage.setItem("thread_id", threadId);
      }

      // Remove thinking message
      if (thinkingMsg && thinkingMsg.parentNode) {
        thinkingMsg.remove();
      }

      // Show assistant response
      const reply = data.reply || "I apologize, but I couldn't generate a response. Please try again.";
      appendMessage(reply, "bot");

    } catch (error) {
      console.error("Error:", error);
      
      // Remove thinking message
      if (thinkingMsg && thinkingMsg.parentNode) {
        thinkingMsg.remove();
      }
      
      // Show error message
      let errorText = "Something went wrong. Please try again.";
      
      if (error.message.includes('timeout')) {
        errorText = "Request timed out. Please try again with a shorter message or smaller image.";
      } else if (error.message.includes('401')) {
        errorText = "Authentication error. Please contact support.";
      } else if (error.message.includes('400')) {
        errorText = "Invalid request. Please check your input and try again.";
      } else if (error.message.includes('413')) {
        errorText = "File too large. Please upload a smaller screenshot.";
      } else if (error.message) {
        errorText = error.message;
      }
      
      appendMessage(errorText, "bot", true);
    } finally {
      setLoading(false);
      if (inputField) {
        inputField.focus();
      }
    }

  } catch (outerError) {
    console.error("Outer error in sendMessage:", outerError);
    setLoading(false);
    appendMessage("An unexpected error occurred. Please refresh the page and try again.", "bot", true);
  }
}

// Initialize when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
