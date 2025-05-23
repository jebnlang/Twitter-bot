import { chromium } from 'playwright-extra';
import { Page } from 'playwright-core';
import stealth from 'puppeteer-extra-plugin-stealth';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios'; // Added axios import for API calls

// Load environment variables
dotenv.config();
chromium.use(stealth());

// --- Environment Variables ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PLAYWRIGHT_STORAGE = process.env.PLAYWRIGHT_STORAGE || 'auth.json';
const POST_WRITER_PERSONA_FILENAME = process.env.BRAIN_PERSONA_FILENAME || 'persona_2.md';
const POST_WRITER_CSV_LOG_FILE = process.env.POST_WRITER_CSV_LOG_FILE || 'created_posts_log.csv'; // Default CSV log filename
const HEADLESS_MODE = process.env.POST_WRITER_HEADLESS_MODE !== 'false'; // Default to true (headless)
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// --- Basic Validations ---
if (!OPENAI_API_KEY) {
  console.error('Post Writer Agent: Error - OPENAI_API_KEY is not defined. Please set it in your .env file.');
  process.exit(1);
}
if (!PLAYWRIGHT_STORAGE || !(require('fs')).existsSync(PLAYWRIGHT_STORAGE)) { // Synchronous check for startup
    console.error(`Post Writer Agent: Error - PLAYWRIGHT_STORAGE path ("${PLAYWRIGHT_STORAGE}") is not defined or auth.json does not exist. Please run authentication.`);
    process.exit(1);
}
if (!TAVILY_API_KEY) {
  console.error('Post Writer Agent: Error - TAVILY_API_KEY is not defined in your .env file.');
  process.exit(1);
}

// --- OpenAI Client ---
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// --- Tavily API Client (Direct REST API Calls) ---
// Simple wrapper functions for Tavily API calls
const tavilyApi = {
  async search(query: string, options: any = {}): Promise<any> {
    if (!TAVILY_API_KEY) {
      throw new Error('Tavily API Key is required');
    }

    try {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY_API_KEY,
        query,
        search_depth: options.search_depth || 'basic',
        max_results: options.max_results || 5,
        include_images: options.include_images || false,
        include_answer: options.include_answer || false,
        include_raw_content: options.include_raw_content || false,
      });
      
      return response.data;
    } catch (error: any) {
      console.error('Tavily API Error:', error.response?.data || error.message);
      throw error;
    }
  }
};

// --- Helper: Type with Jitter (copied from poster.ts) ---
async function typeWithJitter(page: Page, selector: string, text: string, jitterMs: number = 25) {
  await page.waitForSelector(selector, { state: 'visible' });
  for (const char of text) {
    await page.type(selector, char, { delay: jitterMs + (Math.random() * jitterMs) }); // Add some randomness to jitter
  }
}

// --- Persona ---
let postWriterPersonaContent: string = 'Default Post Writer Persona: Create an engaging and informative tweet.'; // Fallback

async function loadPostWriterPersona(): Promise<void> {
  const personaFilePath = path.resolve(POST_WRITER_PERSONA_FILENAME);
  try {
    console.log(`Post Writer Agent: Loading persona from ${personaFilePath}`);
    postWriterPersonaContent = await fs.readFile(personaFilePath, 'utf8');
    console.log('Post Writer Agent: Persona loaded successfully.');
  } catch (error) {
    console.error(`Post Writer Agent: Error loading persona file from ${personaFilePath}. Using fallback persona.`, error);
  }
}

// --- CSV Log Handling ---
const CSV_FILE_PATH = path.resolve(POST_WRITER_CSV_LOG_FILE);

interface PostLogEntry {
  timestamp: string;
  postedText: string;
  postUrl?: string;
  topic?: string;
}

async function loadPreviousPosts(): Promise<PostLogEntry[]> {
  try {
    await fs.access(CSV_FILE_PATH); // Check if file exists
    const data = await fs.readFile(CSV_FILE_PATH, 'utf8');
    const lines = data.split('\n').filter(line => line.trim() !== '');
    if (lines.length <= 1) return []; // Only header or empty

    const posts: PostLogEntry[] = [];
    const header = lines[0].split('","').map(h => h.replace(/^"|"$/g, ''));
    const topicIndex = header.indexOf('topic');

    for (let i = 1; i < lines.length; i++) {
        // Basic CSV parsing, handles potential commas within quoted fields if not too complex
        const values = lines[i].split('","').map(field => field.replace(/^"|"$/g, ''));
        const timestamp = values[0];
        const postedText = values[1];
        const postUrl = values[2] || undefined; // Handle empty string for URL
        const topic = topicIndex !== -1 && values[topicIndex] ? values[topicIndex] : undefined;

        if (timestamp && postedText) {
            posts.push({ timestamp, postedText, postUrl, topic });
        }
    }
    console.log(`Post Writer Agent: Loaded ${posts.length} previous posts from ${CSV_FILE_PATH}.`);
    return posts;
  } catch (error:any) {
    if (error.code === 'ENOENT') {
      console.log(`Post Writer Agent: Log file ${CSV_FILE_PATH} not found. Assuming no previous posts.`);
      // Create the file with headers including topic
      await fs.writeFile(CSV_FILE_PATH, '"timestamp","postedText","postUrl","topic"\n');
      console.log(`Post Writer Agent: Created log file ${CSV_FILE_PATH} with headers.`);
      return [];
    }
    console.error('Post Writer Agent: Error loading previous posts:', error);
    return [];
  }
}

async function appendPostToLog(newPost: PostLogEntry): Promise<void> {
  // Ensure topic is an empty string if undefined, for consistent CSV structure
  const topicForCsv = newPost.topic || ''; 
  const csvLine = `"${newPost.timestamp}","${newPost.postedText.replace(/"/g, '""')}","${newPost.postUrl || ''}","${topicForCsv.replace(/"/g, '""')}"\n`;
  try {
    await fs.appendFile(CSV_FILE_PATH, csvLine);
    console.log(`Post Writer Agent: Successfully appended new post to ${CSV_FILE_PATH}`);
  } catch (error) {
    console.error('Post Writer Agent: Error appending post to log:', error);
  }
}

// --- Function to get a unique topic and fresh context ---
interface TopicContextResult {
  topic: string | null;
  searchContext: string | null;
}

async function getUniqueTopicAndFreshContext(
  previousTopics: (string | undefined)[]
): Promise<TopicContextResult> {
  console.log('Post Writer Agent: Attempting to find a unique topic and fresh context...');
  const recentTopicsToAvoid = previousTopics.slice(-7).filter(t => t !== undefined) as string[];
  console.log('Post Writer Agent: Recent topics to avoid:', recentTopicsToAvoid);

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    console.log(`Post Writer Agent: Topic finding attempt ${attempts}/${maxAttempts}`);
    
    let broadSearchQuery = 'latest news and trends in AI prompt engineering';
    if (attempts === 2) broadSearchQuery = 'hot topics in large language models and prompting techniques';
    if (attempts === 3) broadSearchQuery = 'breakthroughs in AI interaction and prompt crafting';
    
    let broadSearchResults;
    try {
      console.log(`Post Writer Agent: Performing broad Tavily search: "${broadSearchQuery}"`);
      const tavilyResponse = await tavilyApi.search(broadSearchQuery, {
        search_depth: "basic",
        max_results: 7,
      });
      broadSearchResults = tavilyResponse.results; 

      if (!broadSearchResults || broadSearchResults.length === 0) {
        console.warn('Post Writer Agent: Tavily broad search returned no results.');
        if (attempts === maxAttempts) return { topic: null, searchContext: null };
        await new Promise(resolve => setTimeout(resolve, 1500)); 
        continue;
      }
    } catch (searchError) {
      console.error('Post Writer Agent: Error during Tavily broad search:', searchError);
      if (attempts === maxAttempts) return { topic: null, searchContext: null };
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }

    const candidateTopics: string[] = broadSearchResults
      .map((result: any) => result.title)
      .filter((title: string | null): title is string => title !== null && title.trim() !== '');

    if (candidateTopics.length === 0) {
      console.warn('Post Writer Agent: Could not extract any candidate topics from Tavily broad search results.');
      if (attempts === maxAttempts) return { topic: null, searchContext: null };
      continue; 
    }

    for (const candidateTopic of candidateTopics) {
      if (!recentTopicsToAvoid.some(avoid => avoid.toLowerCase() === candidateTopic.toLowerCase())) {
        console.log(`Post Writer Agent: Found unique candidate topic from broad search: "${candidateTopic}"`);
        
        console.log(`Post Writer Agent: Performing focused Tavily search on topic: "${candidateTopic}"`);
        try {
          const focusedTavilyResponse = await tavilyApi.search(candidateTopic, {
            search_depth: "advanced",
            max_results: 5,
            include_answer: false,
            include_raw_content: false,
            include_images: false, 
          });
          const focusedSearchResults = focusedTavilyResponse.results;

          if (!focusedSearchResults || focusedSearchResults.length === 0) {
            console.warn(`Post Writer Agent: Tavily focused search for "${candidateTopic}" returned no results.`);
            continue; 
          }

          const formattedFocusedSearchContext = focusedSearchResults
            .map((r: any, i: number) => `Relevant Information Source ${i+1}: "${r.title}"\nURL: ${r.url}\nContent: ${r.content}`)
            .join('\n\n---\n');
          
          console.log(`Post Writer Agent: Successfully gathered focused context for "${candidateTopic}" from Tavily.`);
          return { topic: candidateTopic, searchContext: formattedFocusedSearchContext };

        } catch (focusedSearchError) {
          console.error(`Post Writer Agent: Error during Tavily focused search for topic "${candidateTopic}":`, focusedSearchError);
          continue; 
        }
      }
    }
    console.warn('Post Writer Agent: All candidate topics from this broad search were similar to recent posts or focused search failed. Retrying broad search if attempts left.');
  }

  console.warn('Post Writer Agent: Could not find a unique topic and gather focused context after max attempts with Tavily.');
  return { topic: null, searchContext: null };
}

// --- OpenAI Content Generation ---
async function generateNewPost(persona: string, previousPostTexts: string[], currentTopic: string, searchContext: string): Promise<{ tweet: string | null; generatedTopic: string | null }> {
  console.log(`Post Writer Agent: Generating new post on topic "${currentTopic}" with OpenAI...`);
  let promptContent = `Your primary goal is to embody the following Twitter persona. Adhere to it strictly.
--- PERSONA START ---
${persona}
--- PERSONA END ---

Based on this persona, you need to draft a new, original tweet. The tweet should be insightful, valuable, and sound human—like an experienced builder sharing knowledge, not a marketing department.

--- EXAMPLES OF TWEET STYLE ---
GOOD EXAMPLE (Adheres to Persona):
Tweet: "After a decade debugging distributed systems, the one constant is change. Embrace observability, not just as a tool, but as a mindset. Know your state."
Reasoning: This tweet is good because it shares an experienced insight, uses a confident and direct tone, and avoids marketing language, hashtags, and questions.

BAD EXAMPLE (Violates Persona):
Tweet: "🚀 Excited to announce our new AI-powered widget! It will revolutionize your workflow! #AI #Innovation. Thoughts?"
Reasoning: This tweet is bad because it uses emojis excessively, marketing hype, hashtags, and ends with a question, all violating the persona rules.
--- END EXAMPLES OF TWEET STYLE ---

Key rules to follow for THIS TWEET:
1.  DO NOT ask any questions, especially at the end of the tweet. No exceptions.
2.  DO NOT use hashtags.
3.  DO NOT use em dashes (—).
4.  AVOID marketing hype, overly enthusiastic language, or corporate-sounding phrases. Focus on authenticity and genuine insight.
5.  Ensure the tweet is fresh and unique, and not too similar in topic or phrasing to the previously posted tweets listed below.
6.  DO NOT mention Teleprompt or its features in this tweet. The product description in the persona is only context, not content.
7.  Maximize readability with short, punchy sentences and **ensure you use double line breaks (\n\n) between paragraphs or distinct ideas to create visual spacing, similar to the provided example image.**
8.  **AIM FOR A LENGTH OF AROUND 600 CHARACTERS (approximately 3-5 substantial paragraphs) to provide in-depth, insightful, and educational content.**
9.  **The primary topic for this tweet should be: "${currentTopic}".** Draw inspiration and information from the 'RECENT WEB SEARCH CONTEXT' provided below.
`;

  promptContent += '\n--- RECENT WEB SEARCH CONTEXT (for relevance and inspiration) ---\n';
  promptContent += searchContext;
  promptContent += '\n--- END RECENT WEB SEARCH CONTEXT ---\n';


  if (previousPostTexts.length > 0) {
    promptContent += '\n--- PREVIOUSLY POSTED TWEETS (for ensuring originality) ---';
    previousPostTexts.slice(-5).forEach((text, index) => {
      promptContent += `\nPrevious Post ${index + 1}: ${text}`;
    });
    promptContent += '\n--- END PREVIOUSLY POSTED TWEETS ---';
  }

  promptContent += `
--- INSTRUCTIONS FOR YOUR RESPONSE ---
Before you provide the final tweet, first write a short (1-2 sentence) 'Persona Alignment Check:' where you briefly explain how your planned tweet aligns with the core persona attributes and the given topic.

Next, on a new line, clearly starting with 'Generated Topic:', provide the main topic of the tweet you are about to write. This should closely match or be a refinement of the provided topic: "${currentTopic}".

Then, on a new line, clearly starting with 'Tweet:', provide ONLY the tweet text.

Example of response format:
Persona Alignment Check: This tweet reflects an experienced builder sharing a direct observation on [topic], avoids hype and questions.
Generated Topic: [Main topic of the tweet]
Tweet: [Your carefully crafted tweet text here]
--- END INSTRUCTIONS FOR YOUR RESPONSE ---

Now, draft the new tweet based on all the above instructions.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: "You are an AI assistant strictly following a detailed persona and set of rules to draft a unique, insightful, and well-structured Twitter post of approximately 600 characters on a given topic, using provided web search context. Your main job is to adhere to all constraints, especially regarding tone, style, length, paragraph structure (double line breaks), providing a persona alignment check, explicitly stating the generated topic, and avoiding questions." },
        { role: 'user', content: promptContent },
      ],
      max_tokens: 450, // Adjusted for topic, context, alignment check + ~600 char tweet
      temperature: 0.7,
      n: 1,
    });

    if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
      const rawResponse = completion.choices[0].message.content.trim();
      console.log(`Post Writer Agent: OpenAI raw response:\n${rawResponse}`);

      const alignmentCheckMatch = rawResponse.match(/Persona Alignment Check:(.*?)Generated Topic:/is);
      const generatedTopicMatch = rawResponse.match(/Generated Topic:(.*?)Tweet:/is);
      const tweetMatch = rawResponse.match(/Tweet:(.*)/is);

      let alignmentText = null;
      let finalGeneratedTopic = null;
      let newTweetText = null;

      if (alignmentCheckMatch && alignmentCheckMatch[1]) {
        alignmentText = alignmentCheckMatch[1].trim();
        console.log(`Post Writer Agent: Persona Alignment Check: ${alignmentText}`);
      }
      if (generatedTopicMatch && generatedTopicMatch[1]) {
        finalGeneratedTopic = generatedTopicMatch[1].trim();
        console.log(`Post Writer Agent: OpenAI stated generated topic: "${finalGeneratedTopic}"`);
      }
      if (tweetMatch && tweetMatch[1]) {
        newTweetText = tweetMatch[1].trim();
        console.log(`Post Writer Agent: Extracted tweet: "${newTweetText}"`);
        if (newTweetText.toLowerCase().includes("error") || newTweetText.length < 10 || newTweetText.includes("?")) {
          console.warn("Post Writer Agent: OpenAI generated a very short, error-like, or question-containing tweet.");
          return { tweet: null, generatedTopic: finalGeneratedTopic }; // Return topic even if tweet is bad for logging context
        }
      } else {
        console.error('Post Writer Agent: Could not extract tweet from OpenAI response using "Tweet:" prefix.');
      }
      // Return tweet and the topic OpenAI generated, even if tweet extraction failed but topic was found.
      // This helps in debugging and deciding if the topic itself was problematic.
      return { tweet: newTweetText, generatedTopic: finalGeneratedTopic }; 
    } else {
      console.error('Post Writer Agent: OpenAI did not return valid content.');
      return { tweet: null, generatedTopic: null };
    }
  } catch (error) {
    console.error('Post Writer Agent: Error calling OpenAI API:', error);
    return { tweet: null, generatedTopic: null };
  }
}

// --- Playwright Posting Logic ---
async function publishTwitterPost(postText: string): Promise<string | null> {
  console.log('Post Writer Agent: Launching browser to post tweet...');
  const browser = await chromium.launch({ headless: HEADLESS_MODE });
  const context = await browser.newContext({ storageState: PLAYWRIGHT_STORAGE });
  const page = await context.newPage();
  let postUrl: string | null = null;

  try {
    console.log('Post Writer Agent: Navigating to Twitter compose page...');
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for the main tweet input area to be ready
    const tweetEditorSelector = 'div.public-DraftEditor-content[role="textbox"]';
    console.log(`Post Writer Agent: Waiting for tweet editor: ${tweetEditorSelector}`);
    await page.waitForSelector(tweetEditorSelector, { state: 'visible', timeout: 30000 });
    console.log('Post Writer Agent: Tweet editor found. Typing post...');
    await typeWithJitter(page, tweetEditorSelector, postText, 25); // Using typeWithJitter

    // Click the "Post" button
    const postButtonSelector = 'button[data-testid="tweetButton"]';
    console.log(`Post Writer Agent: Waiting for Post button: ${postButtonSelector}`);
    await page.waitForSelector(postButtonSelector, { state: 'visible', timeout: 15000 });
    console.log('Post Writer Agent: Clicking Post button...');
    await page.click(postButtonSelector);

    // Try to detect successful post and get URL
    // This is the trickiest part and might need refinement based on actual UI behavior.
    // Option 1: Look for "Your post was sent." notification
    try {
        const notificationSelector = 'div[data-testid="toast"]'; // Common selector for toasts/notifications
        console.log('Post Writer Agent: Waiting for post success notification...');
        await page.waitForSelector(notificationSelector, { timeout: 15000 }); // Wait for any toast
        const toastText = await page.locator(notificationSelector).innerText();
        if (toastText.toLowerCase().includes('your post was sent') || toastText.toLowerCase().includes('post sent')) {
            console.log('Post Writer Agent: "Post sent" notification detected.');
            // Attempt to get URL by navigating to profile and finding the latest tweet
            // This is an indirect way and might not always get the exact post if timing is off
            // A more direct way would be if Twitter API provided it, or if the UI had a direct link on success.
            const profileLink = await page.locator('a[data-testid="AppTabBar_Profile_Link"]').getAttribute('href');
            if (profileLink) {
                console.log(`Post Writer Agent: Navigating to profile ${profileLink} to find post URL.`);
                await page.goto(`https://x.com${profileLink}`, { waitUntil: 'domcontentloaded', timeout: 60000});
                console.log('Post Writer Agent: Waiting for tweets to appear on profile page...');
                await page.waitForSelector('article[data-testid="tweet"]', { state: 'visible', timeout: 20000 }); // Wait for the first tweet article
                const firstTweetLink = await page.locator('article[data-testid="tweet"] a:has(time[datetime])').first().getAttribute('href');
                if (firstTweetLink) {
                    postUrl = `https://x.com${firstTweetLink}`;
                    console.log(`Post Writer Agent: Tentatively identified post URL: ${postUrl}`);
                } else {
                    console.warn('Post Writer Agent: Could not find link to the latest tweet on profile page.');
                }
            }
        } else {
            console.warn(`Post Writer Agent: Received a notification, but it wasn't the expected success message: "${toastText}"`);
        }
    } catch (e:any) {
      console.warn(`Post Writer Agent: Did not find a clear success notification or failed to get post URL. Error: ${e.message}. Assuming post might have failed or URL retrieval is not possible this way.`);
    }

    if (!postUrl) {
        console.log("Post Writer Agent: Post URL not retrieved. The post might still be successful.");
    }
    
    console.log('Post Writer Agent: Pausing briefly after attempting post...');
    await page.waitForTimeout(3000);

  } catch (error: any) {
    console.error('Post Writer Agent: Error during Playwright posting operation:', error);
    // In case of error, we don't have a URL
    postUrl = null; 
    // Optionally, take a screenshot on error if not headless for debugging
    // if (!HEADLESS_MODE) {
    //   await page.screenshot({ path: 'post_writer_error.png' });
    //   console.log('Post Writer Agent: Screenshot taken as post_writer_error.png');
    // }
  } finally {
    console.log('Post Writer Agent: Closing browser.');
    if (browser && browser.isConnected()) {
      await browser.close();
    }
  }
  return postUrl; // This will be null if URL couldn't be confirmed
}


// --- Main Execution ---
async function mainPostWriter() {
  console.log('--- Post Writer Agent Starting ---');

  await loadPostWriterPersona();

  const previousPosts = await loadPreviousPosts();
  const previousPostTexts = previousPosts.map(p => p.postedText);
  const previousTopics = previousPosts.map(p => p.topic);

  const { topic: currentTopic, searchContext } = await getUniqueTopicAndFreshContext(previousTopics);

  if (!currentTopic || !searchContext) {
    console.error('Post Writer Agent: Could not determine a unique topic or fetch search context. Exiting.');
    return;
  }

  let newPostText: string | null = null;
  let finalGeneratedTopicForLog: string | null = null; // To store the topic confirmed by OpenAI
  const maxRetries = 3; 

  for (let i = 0; i < maxRetries; i++) {
    console.log(`Post Writer Agent: Attempt ${i + 1} to generate a new post on topic: "${currentTopic}".`);
    const generationResult = await generateNewPost(postWriterPersonaContent, previousPostTexts, currentTopic, searchContext);
    newPostText = generationResult.tweet;
    finalGeneratedTopicForLog = generationResult.generatedTopic || currentTopic; // Fallback to originally selected topic if AI doesn't specify one

    if (newPostText) {
      console.log(`Post Writer Agent: Successfully generated post content: "${newPostText}" with topic "${finalGeneratedTopicForLog}"`);
      break;
    }
    if (i < maxRetries - 1) {
      console.log('Post Writer Agent: Failed to generate suitable post, retrying after a short delay...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (!newPostText) {
    console.error(`Post Writer Agent: Failed to generate new post content for topic "${finalGeneratedTopicForLog || currentTopic}" after multiple attempts. Exiting.`);
    // Still log the attempt with the topic, even if post generation failed, to avoid retrying this topic soon if it was problematic
    if (finalGeneratedTopicForLog || currentTopic) { // Ensure we have some topic to log
        const logEntry: PostLogEntry = {
            timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }),
            postedText: "GENERATION FAILED",
            postUrl: undefined,
            topic: finalGeneratedTopicForLog === null ? undefined : finalGeneratedTopicForLog, 
        };
        await appendPostToLog(logEntry);
        console.log(`Post Writer Agent: Logged failed generation attempt for topic: "${finalGeneratedTopicForLog || currentTopic}"`);
    }
    return;
  }

  const postedTweetUrl = await publishTwitterPost(newPostText);

  const logEntry: PostLogEntry = {
    timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }),
    postedText: newPostText,
    postUrl: postedTweetUrl || undefined,
    topic: finalGeneratedTopicForLog === null ? undefined : finalGeneratedTopicForLog, // Convert null to undefined for CSV logging
  };
  await appendPostToLog(logEntry);

  if (postedTweetUrl) {
    console.log(`Post Writer Agent: Post published successfully. URL: ${postedTweetUrl}`);
  } else {
    console.log('Post Writer Agent: Post published but URL not retrieved.');
  }
}

mainPostWriter();