import formidable from "formidable";
import { readFileSync } from "fs";
import OpenAI from "openai";
import crypto from "crypto";

// Disable body parser for file uploads 
export const config = { 
  api: { 
    bodyParser: false 
  } 
};

// Security configuration
const ALLOWED_COMPANIES = process.env.ALLOWED_COMPANY_DOMAINS?.split(',') || [];
const LM_STUDIO_API_KEY = process.env.LM_STUDIO_SECRET_KEY; // Your secret key
const LM_STUDIO_URL = process.env.LM_STUDIO_URL; // Your secure tunnel URL

// Configure OpenAI client to point to your secured LM Studio endpoint
const openai = new OpenAI({ 
  apiKey: LM_STUDIO_API_KEY,
  baseURL: LM_STUDIO_URL
});

// Rate limiting storage (in production, use Redis)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // per minute per IP

// Session Management
const sessionStore = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Clean up old sessions automatically
setInterval(() => {
  const now = Date.now();
  
  for (let [sessionId, data] of sessionStore.entries()) {
    if (now - data.lastActivity > SESSION_TIMEOUT) {
      sessionStore.delete(sessionId);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

//function validateCompanyAccess(req) {
 // const host = req.headers.host || '';
//  const origin = req.headers.origin || '';
  
  // Extract subdomain (e.g., "companyname" from "companyname.yourdomain.com")
//  const subdomain = host.split('.')[0];
  
  // Check if this company is authorized
//  if (!ALLOWED_COMPANIES.includes(subdomain)) {
//    throw new Error('Unauthorized company access');
//  }
 
//  return subdomain;
// }

function checkRateLimit(clientIP) {
  const now = Date.now();
  const clientRequests = rateLimitMap.get(clientIP) || [];
  
  // Remove old requests outside the window
  const recentRequests = clientRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
    throw new Error('Rate limit exceeded');
  }
  
  // Add current request
  recentRequests.push(now);
  rateLimitMap.set(clientIP, recentRequests);
}

function sanitizeInput(text) {
  // Remove potential injection attempts
  return text
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim()
    .substring(0, 4000); // Limit length
}

// Session helper functions
function getConversationHistory(sessionId) {
  const session = sessionStore.get(sessionId) || { 
    messages: [], 
    lastActivity: Date.now() 
  };
  session.lastActivity = Date.now();
  return session.messages;
}

function addToHistory(sessionId, message) {
  const session = sessionStore.get(sessionId) || { 
    messages: [], 
    lastActivity: Date.now() 
  };
  
  // Keep only last 10 messages (5 user + 5 assistant pairs)
  if (session.messages.length >= 10) {
    session.messages.shift(); // Remove oldest
  }
  
  session.messages.push(message);
  session.lastActivity = Date.now();
  sessionStore.set(sessionId, session);
}

export default async function handler(req, res) {
  // Enable CORS for allowed origins only
 // try {
  //  const companySubdomain = validateCompanyAccess(req);
//    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
 // } catch (error) {
 //   return res.status(403).json({ error: 'Access denied' });
//  }
  // Instead, just allow all origins temporarily:
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Company-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Rate limiting
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    checkRateLimit(clientIP);

    // Validate required environment variables
    if (!LM_STUDIO_API_KEY || !LM_STUDIO_URL) {
      console.error("Missing LM Studio configuration");
      return res.status(500).json({ error: "Service temporarily unavailable" });
    }

    // Parse multipart/form-data with strict limits
    const form = formidable({
      multiples: false,
      maxFiles: 1,
      maxFileSize: 5 * 1024 * 1024, // Reduced to 5MB
      maxFieldsSize: 10000,
      filter: ({ mimetype, name }) => {
        // Only allow specific file types and field names
        if (name === 'screenshot') {
          return ["image/png", "image/jpeg"].includes(mimetype?.toLowerCase());
        }
        return ['message', 'thread_id', 'session_id'].includes(name);
      }
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error("Form parse error:", err);
          reject(new Error("Invalid form data"));
        } else {
          resolve({ fields, files });
        }
      });
    });

    // Extract and sanitize data
    const message = sanitizeInput(Array.isArray(fields.message) ? fields.message[0] : (fields.message || ""));
    const incomingThreadId = Array.isArray(fields.thread_id) ? fields.thread_id[0] : fields.thread_id;
    const sessionId = Array.isArray(fields.session_id) ? fields.session_id[0] : (fields.session_id || crypto.randomBytes(16).toString('hex'));
    const screenshotFile = Array.isArray(files.screenshot) ? files.screenshot[0] : files.screenshot;

    // console.log(`Request from company: ${validateCompanyAccess(req)}`);
    console.log("Message length:", message.length);
    console.log("Screenshot file:", screenshotFile ? "Yes" : "No");
    console.log("Session ID:", sessionId);

    // Validate message content
    if (!message.trim() && !screenshotFile) {
      return res.status(400).json({ error: "Message or screenshot required" });
    }
    
    // Build conversation with security context
    let conversationMessages = [
      {
        role: "system",
        content: `You are an IT support assistant who helps users step-by-step. CRITICAL WORKFLOW RULES:
          
        ALWAYS provide only ONE solution at a time
        After giving a solution, ALWAYS ask the user to try it and report back
        NEVER list multiple options or methods simultaneously
        Wait for user confirmation before moving to the next solution
        Only escalate to IT professionals after trying 2-3 individual solutions

        TASK COMPLETION RULES:
When the user confirms their issue is resolved (e.g., "it works", "that fixed it", "it's working now"):
1. Acknowledge the successful resolution
2. Provide a brief summary of what was done
3. Ask if they need help with anything else IT-related
4. If they say no or thank you, end with: "Great! This support session is now complete. Feel free to start a new conversation if you need IT help in the future"


COMPLETION INDICATORS to watch for:
- "It works", "That fixed it", "It's working", "Problem solved"
- "Thank you", "Thanks", "All good", "Perfect"
- "No other issues", "That's all", "Nothing else"
       
        Remember: One solution at a time, wait for feedback, then proceed to the next step based on results. After Result, respond with, "Great! This support session is now complete. Feel free to start a new conversation if you need IT help in the future"`

      
    
      }
    ];

    // Add conversation history
    const history = getConversationHistory(sessionId);
    if (history.length > 0) {
      conversationMessages.push(...history);
    }

    // In your conversationMessages array, you could add:
    if (message.includes("didn't work") || message.includes("not working")) {
      userContent.unshift({
        type: "text",
        text: `Previous solution didn't work. Please provide the NEXT most likely solution (not a list of multiple options). ${message}`
      });
    }
    // Create user message content
    let userContent = [];
    
    if (message.trim()) {
      userContent.push({
        type: "text",
        text: message
      });
    }

    // Process screenshot with additional security checks
    if (screenshotFile && screenshotFile.filepath) {
      try {
        const imageBuffer = readFileSync(screenshotFile.filepath);
        
        // Security: Check file signature to ensure it's actually an image
        const signature = imageBuffer.toString('hex', 0, 8);
        const validSignatures = ['89504e47', 'ffd8ffe0', 'ffd8ffe1', 'ffd8ffe2']; // PNG, JPEG headers
        if (!validSignatures.some(sig => signature.startsWith(sig))) {
          throw new Error("Invalid image file");
        }

        const base64Image = imageBuffer.toString('base64');
        const imageFormat = screenshotFile.mimetype?.includes('png') ? 'png' : 'jpeg';
        
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/${imageFormat};base64,${base64Image}`,
            detail: "low" // Use low detail to reduce processing load
          }
        });
        
        if (!message.trim()) {
          userContent.unshift({
            type: "text",
            text: "Please analyze this screenshot and provide troubleshooting steps."
          });
        }
      } catch (imageError) {
        console.error("Image processing error:", imageError);
        return res.status(400).json({ error: "Invalid image file" });
      }
    }

    const userMessage = {
      role: "user",
      content: userContent
    };

    conversationMessages.push(userMessage);

    // Store user message in history
    addToHistory(sessionId, userMessage);

    // Make secure request to LM Studio with timeout
    const completion = await Promise.race([
      openai.chat.completions.create({
        model: "google/gemma-3-12b",
        messages: conversationMessages,
        max_tokens: 800, // Reduced to control costs
        temperature: 0.5,
        stream: false
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout')), 30000) // 30 second timeout
      )
    ]);

    const reply = completion.choices[0]?.message?.content || "I couldn't process your request. Please try again.";

    // Store assistant response in history
    addToHistory(sessionId, {
      role: "assistant", 
      content: reply
    });

    // Generate secure thread ID
    const threadId = incomingThreadId || `thread_${crypto.randomBytes(16).toString('hex')}`;

    return res.status(200).json({ 
      reply: reply.substring(0, 2000), // Limit response size
      thread_id: threadId,
      session_id: sessionId
    });

  } catch (error) {
    console.error("API error:", error);
    
    // Don't leak internal error details
    if (error.message === 'Rate limit exceeded') {
      return res.status(429).json({ error: "Too many requests. Please wait before trying again." });
    } else if (error.message === 'Unauthorized company access') {
      return res.status(403).json({ error: "Access denied" });
    } else if (error.message.includes('ECONNREFUSED')) {
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }
    
    return res.status(500).json({ error: "Internal server error" });
  }
}
