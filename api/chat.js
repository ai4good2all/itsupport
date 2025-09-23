import formidable from "formidable";
import { createReadStream } from "fs";
import OpenAI from "openai";

// Disable body parser for file uploads
export const config = { 
  api: { 
    bodyParser: false 
  } 
};

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

const assistantId = process.env.ASSISTANT_ID;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Validate environment variables
    if (!process.env.OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY");
      return res.status(500).json({ error: "Server configuration error" });
    }
    if (!assistantId) {
      console.error("Missing ASSISTANT_ID");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Parse multipart/form-data
    const form = formidable({
      multiples: false,
      maxFiles: 1,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      filter: ({ mimetype }) => {
        if (!mimetype) return true;
        return ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimetype.toLowerCase());
      }
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error("Form parse error:", err);
          reject(err);
        } else {
          resolve({ fields, files });
        }
      });
    });

    // Extract data from parsed form
    const message = Array.isArray(fields.message) ? fields.message[0] : (fields.message || "");
    const incomingThreadId = Array.isArray(fields.thread_id) ? fields.thread_id[0] : fields.thread_id;
    const screenshotFile = Array.isArray(files.screenshot) ? files.screenshot[0] : files.screenshot;

    console.log("Received message:", message);
    console.log("Thread ID:", incomingThreadId);
    console.log("Screenshot file:", screenshotFile ? "Yes" : "No");

    // Validate message content
    if (!message.trim() && !screenshotFile) {
      return res.status(400).json({ error: "Message or screenshot required" });
    }

    // Create or use existing thread
    let threadId = incomingThreadId;
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      console.log("Created new thread:", threadId);
    } else {
      console.log("Using existing thread:", threadId);
    }

    // Upload screenshot if provided
    let fileId = null;
    if (screenshotFile && screenshotFile.filepath) {
      try {
        const uploadedFile = await openai.files.create({
          file: createReadStream(screenshotFile.filepath),
          purpose: "vision"  // Changed from "assistants" to "vision" for better image analysis
        });
        fileId = uploadedFile.id;
        console.log("Uploaded file for vision:", fileId);
      } catch (uploadError) {
        console.error("File upload error:", uploadError);
        // Try fallback to assistants purpose
        try {
          const uploadedFile = await openai.files.create({
            file: createReadStream(screenshotFile.filepath),
            purpose: "assistants"
          });
          fileId = uploadedFile.id;
          console.log("Uploaded file for assistants:", fileId);
        } catch (fallbackError) {
          console.error("Fallback file upload error:", fallbackError);
          return res.status(500).json({ error: "Failed to upload screenshot" });
        }
      }
    }

    // Prepare message content with image
    let messageContent;
    
    if (fileId) {
      // For images, use the content array format that supports vision
      messageContent = [
        {
          type: "text",
          text: message.trim() || "I've uploaded a screenshot for you to analyze. Please help me troubleshoot the issue shown in this image."
        },
        {
          type: "image_file",
          image_file: {
            file_id: fileId
          }
        }
      ];
    } else {
      // Text only message
      messageContent = message.trim() || "Hello, I need IT support assistance.";
    }

    // Add user message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: messageContent
    });
    
    console.log("Added message to thread with content type:", typeof messageContent);

    // Create and run the assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId
    });

    console.log("Created run:", run.id);

    // Poll for completion
    let runStatus = run.status;
    let attempts = 0;
    const maxAttempts = 60; // 2 minutes max

    while (!["completed", "failed", "cancelled", "expired"].includes(runStatus) && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      
      const currentRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
      runStatus = currentRun.status;
      attempts++;
      
      console.log(`Run status: ${runStatus}, attempt: ${attempts}`);

      // Handle requires_action status (for function calls)
      if (runStatus === "requires_action") {
        console.log("Run requires action - this shouldn't happen with basic assistant");
        break;
      }
    }

    // Clean up uploaded file for privacy
    if (fileId) {
      try {
        await openai.files.del(fileId);
        console.log("Deleted uploaded file:", fileId);
      } catch (deleteError) {
        console.warn("Failed to delete file:", deleteError.message);
        // Don't fail the request if file deletion fails
      }
    }

    // Check final run status
    if (runStatus !== "completed") {
      console.error("Run did not complete successfully:", runStatus);
      return res.status(500).json({ 
        error: `Assistant run ${runStatus}`, 
        thread_id: threadId 
      });
    }

    // Get the assistant's response
    const messages = await openai.beta.threads.messages.list(threadId, {
      order: "desc",
      limit: 10
    });

    const assistantMessage = messages.data.find(msg => msg.role === "assistant");
    
    let reply = "I apologize, but I couldn't generate a response. Please try again.";
    if (assistantMessage && assistantMessage.content && assistantMessage.content.length > 0) {
      const textContent = assistantMessage.content.find(content => content.type === "text");
      if (textContent && textContent.text && textContent.text.value) {
        reply = textContent.text.value;
      }
    }

    console.log("Sending response");
    return res.status(200).json({ 
      reply, 
      thread_id: threadId 
    });

  } catch (error) {
    console.error("API error details:", error);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    
    // Provide more specific error messages
    if (error.code === 'invalid_api_key') {
      return res.status(401).json({ error: "Invalid API key" });
    } else if (error.code === 'model_not_found') {
      return res.status(400).json({ error: "Assistant not found" });
    } else if (error.message && error.message.includes('timeout')) {
      return res.status(408).json({ error: "Request timeout" });
    }
    
    return res.status(500).json({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : "Check server logs"
    });
  }
}
