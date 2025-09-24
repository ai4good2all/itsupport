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

    // Instead of using Assistants API, use Chat Completions with vision
    // This provides better image analysis capabilities
    
    let conversationMessages = [
      {
        role: "system",
        content: `I need you to help me diagnose why my computer is having an issue that the customer is stating. We need to diagnose it one step at a time. Each step you can ask me to do something and then take a screenshot to verify that I did it correctly. Always start by asking for a screenshot of my system to know what you are working with. Here is a list of the requirements of your tasks for assisting as an IT Support agent:

-Only look for the issue stated by the user when analyzing the screen shots to save memory
-Only help with the permission that is available. For example, if issues needs to be resolved with an elevate administration password, to state that you dont have the required access to further assist and they should reach out to the companies it support techs.
-Only solve issues related for IT related tasks. Any mention about helping with another task, please state that you are only here to troubleshoot it related task. So please consult the proper assistant to get further help. If it is IT related, I would be gladly able to assist.`
      }
    ];

    // Create user message content
    let userContent = [];
    
    if (message.trim()) {
      userContent.push({
        type: "text",
        text: message.trim()
      });
    }

    // Handle screenshot with base64 encoding for direct vision analysis
    if (screenshotFile && screenshotFile.filepath) {
      try {
        const fs = await import('fs');
        const imageBuffer = fs.readFileSync(screenshotFile.filepath);
        const base64Image = imageBuffer.toString('base64');
        
        // Determine image format
        let imageFormat = 'png';
        if (screenshotFile.mimetype?.includes('jpeg')) imageFormat = 'jpeg';
        else if (screenshotFile.mimetype?.includes('png')) imageFormat = 'png';
        else if (screenshotFile.mimetype?.includes('webp')) imageFormat = 'webp';

        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/${imageFormat};base64,${base64Image}`,
            detail: "high"
          }
        });

        // Add explicit instruction for image analysis
        if (!message.trim()) {
          userContent.unshift({
            type: "text",
            text: "I've uploaded a screenshot. Please analyze what you can see in this image and provide specific troubleshooting steps based on the visual information."
          });
        }

        console.log("Added image for direct vision analysis");
      } catch (imageError) {
        console.error("Image processing error:", imageError);
        return res.status(500).json({ error: "Failed to process screenshot" });
      }
    }

    // Add user message to conversation
    conversationMessages.push({
      role: "user",
      content: userContent
    });

    // Use Chat Completions API with vision model
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Vision-capable model
      messages: conversationMessages,
      max_tokens: 1000,
      temperature: 0.7
    });

    const reply = completion.choices[0]?.message?.content || "I apologize, but I couldn't generate a response. Please try again.";
    
    // Generate a simple thread ID for session tracking
    const newThreadId = incomingThreadId || `thread_${Date.now()}`;

    console.log("Successfully got vision-enabled response");
    return res.status(200).json({ 
      reply, 
      thread_id: newThreadId 
    });
    
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
