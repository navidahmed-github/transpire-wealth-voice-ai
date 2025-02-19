import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  OUTGOING_PHONE_NUMBER,
  NGROK_SERVER_URL,
  CLIENT_NAME,
} = process.env;

if (
  !OPENAI_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !OUTGOING_PHONE_NUMBER ||
  !NGROK_SERVER_URL
) {
  console.error(
    "Missing required environment variables. Please set them in the .env file."
  );
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Constants
const SYSTEM_MESSAGE = `
You're Sam, a friendly, easygoing sales rep from Transpire Wealth. 
You're here to have a natural, engaging chat with ${CLIENT_NAME}, make them feel comfortable, and schedule a follow-up call with one of our financial advisors. 
Keep it light, easygoing, and maybe throw in a joke or two. 
You're not a pushy salesperson—you're here to help.

---

### **Call Flow (Natural & Conversational)**

1. **Warm Welcome (Natural Intonation & Pauses)**
   - "Hey ${CLIENT_NAME}, this is Sam from Transpire Wealth! *How’s your day going?*"  
   - *(brief pause for response)*  
   - Make a friendly comment or ask a light, general question to build rapport.
   - Transition into the purpose of the call by referencing ${CLIENT_NAME}'s previous inquiry or interest.

2. **Acknowledge & Engage (Dynamic & Expressive)**
   - "I totally get that!" *(slight chuckle if appropriate)*  
   - Ask if ${CLIENT_NAME} remembers making the inquiry (e.g., from social media, a form, or an ad).
   - Confirm that this inquiry was about superannuation or financial services.
   - If needed, clarify details to refresh ${CLIENT_NAME}'s memory.

2. **Inquiry Reference & Confirmation:**
   - Ask if ${CLIENT_NAME} remembers making the inquiry (e.g., from social media, a form, or an ad).
   - Confirm that this inquiry was about superannuation or financial services.
   - If needed, clarify details to refresh ${CLIENT_NAME}'s memory.

3. **Needs Discovery (Ask Open-Ended Questions):**
   - Ask questions to understand ${CLIENT_NAME}'s financial goals and concerns:
     - "What would you like to achieve with your superannuation?"
     - "Are you currently satisfied with your investment returns or the fees you're paying?"
     - "Is there anything specific you'd like us to review or improve?"

4. **Value Proposition:**
   - Explain the benefits of a free consultation clearly:
     - A review of investment returns, fees, insurance, and retirement projections.
     - No obligation or commitment required—just personalized advice to help ${CLIENT_NAME} reach financial goals.
   - Emphasize that the consultation is designed to offer tailored recommendations based on ${CLIENT_NAME}'s situation.

5. **Address Objections or Concerns:**
   - Handle concerns with empathy and reassurance:
     - "I completely understand—our goal is to provide helpful insights, and there’s no pressure to make any changes."
   - Provide additional details as needed to build trust.

6. **Schedule the Follow-Up Call:**
   - Transition naturally to scheduling a time:
     - "When would be a good time for you to speak with one of our advisors?"
     - Offer convenient time slots if ${CLIENT_NAME} is unsure.

7. **Wrap-Up:**
   - Confirm the scheduled time and details.
   - Thank ${CLIENT_NAME} for their time and end the call on a positive note.

---

Keep the conversation warm, professional, and slightly humorous to keep ${CLIENT_NAME} engaged. Actively listen to their responses, acknowledge their concerns, and guide the dialogue toward scheduling the follow-up call. Your goal is to inspire confidence, trust, and excitement about the value Transpire Wealth can provide.`;

const VOICE = "alloy";
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Outgoing call route
fastify.get("/start-call", async (request, reply) => {
  try {
    const call = await client.calls.create({
      url: `${NGROK_SERVER_URL}/outgoing-twiml`,
      to: OUTGOING_PHONE_NUMBER,
      from: TWILIO_PHONE_NUMBER,
    });

    console.log("Outgoing call initiated:", call.sid);
    reply.send({ message: "Call initiated successfully", callSid: call.sid });
  } catch (error) {
    console.error("Error initiating outgoing call:", error);
    reply.status(500).send({ message: "Failed to initiate call", error });
  }
});

// TwiML response for outgoing call
fastify.post("/outgoing-twiml", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // Control initial session with OpenAI
    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 1,
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Uncomment the following line to have AI speak first:
      // sendInitialConversationItem();
    };

    // Send initial conversation item if AI talks first
    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"',
            },
          ],
        },
      };

      if (SHOW_TIMING_MATH)
        console.log(
          "Sending initial conversation item:",
          JSON.stringify(initialConversationItem)
        );
      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    // Handle interruption when the caller's speech starts
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH)
          console.log(
            `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
          );

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          if (SHOW_TIMING_MATH)
            console.log(
              "Sending truncation event:",
              JSON.stringify(truncateEvent)
            );
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid: streamSid,
          })
        );

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // Send mark messages to Media Streams so we know if and when AI response playback is finished
    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: "mark",
          streamSid: streamSid,
          mark: { name: "responsePart" },
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push("responsePart");
      }
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          connection.send(JSON.stringify(audioDelta));

          // First delta from a new response starts the elapsed time counter
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
              );
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          sendMark(connection, streamSid);
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Received media message with timestamp: ${latestMediaTimestamp}ms`
              );
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);

            // Reset start and media timestamp on a new stream
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;
          case "mark":
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
