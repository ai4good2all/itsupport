import formidable from "formidable";
import { readFileSync } from "fs";
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

    // Get conversation history for context
    let conversationHistory = [];
    
    // Add system message with IT support instructions
    conversationHistory.push({
      role: "system",
      content: `I need you to help me diagnose why my computer is having an issue that the customer is stating. We need to diagnose it one step at a time. Each step you can ask me to do something and then take a screenshot to verify that I did it correctly. Always start by asking for a screenshot of my system to know what you are working with. Here is a list of the requirements of your tasks for assisting as an IT Support agent:

-Only look for the issue stated by the user when analyzing the screen shots to save memory
-Only help with the permission that is available. For example, if issues needs to be resolved with an elevate administration password, to state that you dont have the required access to further assist and they should reach out to the companies it support techs.
-Only solve issues related for IT related tasks. Any mention about helping with another task, please state that you are only here to troubleshoot it related task. So please consult the proper assistant to get further help. If it is IT related, I would be gladly able to assist.`
    });

    // Create user message
    let userContent = [];
    
    // Add text content
    if (message.trim()) {
      userContent.push({
        type: "text",
        text: message.trim()
      });
    }

    // Add image content if screenshot provided
    if (screenshotFile && screenshotFile.filepath) {
      try {
        // Read the image file and convert to base64
        const imageBuffer = readFileSync(screenshotFile.filepath);
        const base64Image = imageBuffer.toString('base64');
        
        // Determine the image format
        let imageFormat = 'png'; // default
        if (screenshotFile.mimetype) {
          if (screenshotFile.mimetype.includes('jpeg') || screenshotFile.mimetype.includes('jpg')) {
            imageFormat = 'jpeg';
          } else if (screenshotFile.mimetype.includes('png')) {
            imageFormat = 'png';
          } else if (screenshotFile.mimetype.includes('webp')) {
            imageFormat = 'webp';
          }
        }
        
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/${imageFormat};base64,${base64Image}`,
            detail: "high"
          }
        });
        
        console.log("Added image to message with format:", imageFormat);
        
        // If no text message, add default text for image analysis
        if (!message.trim()) {
          userContent.unshift({
            type: "text",
            text: "I've uploaded a screenshot for you to analyze. Please help me troubleshoot the issue shown in this image."
          });
        }
      } catch (imageError) {
        console.error("Image processing error:", imageError);
        return res.status(500).json({ error: "Failed to process screenshot" });
      }
    }

    // Add user message to conversation
    conversationHistory.push({
      role: "user", 
      content: userContent
    });

    console.log("Making request to OpenAI Chat Completions with", userContent.length, "content items");

    // Make request to OpenAI Chat Completions API
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Use GPT-4 with vision capabilities
      messages: conversationHistory,
      max_tokens: 1000,
      temperature: 0.7
    });

    const reply = completion.choices[0]?.message?.content || "I apologize, but I couldn't generate a response. Please try again.";

    console.log("Received response from OpenAI");
    
    // For simplicity, we'll use a session-based thread ID
    const threadId = incomingThreadId || `thread_${Date.now()}`;

    return res.status(200).json({ 
      reply, 
      thread_id: threadId 
    });

  } catch (error) {
    console.error("API error details:", error);
    console.error("Error message:", error.message);
    
    // Provide more specific error messages
    if (error.code === 'invalid_api_key') {
      return res.status(401).json({ error: "Invalid API key" });
    } else if (error.message && error.message.includes('timeout')) {
      return res.status(408).json({ error: "Request timeout" });
    }
    
    return res.status(500).json({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : "Check server logs"
    });
  }
}
