> ## Documentation Index
> Fetch the complete documentation index at: https://openrouter.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Client Tools

> Use client tools in your prompts

Tool calls (also known as function calls) give an LLM access to external tools. The LLM does not call the tools directly. Instead, it suggests the tool to call. The user then calls the tool separately and provides the results back to the LLM. Finally, the LLM formats the response into an answer to the user's original question.

OpenRouter standardizes the tool calling interface across models and providers, making it easy to integrate external tools with any supported model.

**Supported Models**: You can find models that support tool calling by filtering on [openrouter.ai/models?supported\_parameters=tools](https://openrouter.ai/models?supported_parameters=tools).

If you prefer to learn from a full end-to-end example, keep reading.

## Request Body Examples

Tool calling with OpenRouter involves three key steps. Here are the essential request body formats for each step, first for the [Responses API](https://openrouter.ai/docs/api_reference/responses/overview.md) (`POST /api/v1/responses`) and then for Chat Completions (`POST /api/v1/chat/completions`).

### Responses API

#### Step 1: Inference Request with Tools

```json expandable lines theme={null}
{
  "model": "google/gemini-3-flash-preview",
  "input": [
    {
      "role": "user",
      "content": "What are the titles of some James Joyce books?"
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "search_gutenberg_books",
      "description": "Search for books in the Project Gutenberg library",
      "parameters": {
        "type": "object",
        "properties": {
          "search_terms": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of search terms to find books"
          }
        },
        "required": ["search_terms"],
        "additionalProperties": false
      }
    }
  ]
}
```

#### Step 2: Tool Execution (Client-Side)

After receiving a response whose `output` contains a `function_call` item, execute the requested tool locally and prepare the result:

```javascript lines theme={null}
// Model responds with a function_call output item, you execute the tool locally
const toolResult = await searchGutenbergBooks(["James", "Joyce"]);
```

#### Step 3: Inference Request with Tool Results

```json expandable lines theme={null}
{
  "model": "google/gemini-3-flash-preview",
  "input": [
    {
      "role": "user",
      "content": "What are the titles of some James Joyce books?"
    },
    {
      "type": "function_call",
      "call_id": "call_abc123",
      "name": "search_gutenberg_books",
      "arguments": "{\"search_terms\": [\"James\", \"Joyce\"]}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_abc123",
      "output": "[{\"id\": 4300, \"title\": \"Ulysses\", \"authors\": [{\"name\": \"Joyce, James\"}]}]"
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "search_gutenberg_books",
      "description": "Search for books in the Project Gutenberg library",
      "parameters": {
        "type": "object",
        "properties": {
          "search_terms": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of search terms to find books"
          }
        },
        "required": ["search_terms"],
        "additionalProperties": false
      }
    }
  ]
}
```

### Chat Completions API

On Chat Completions, function tools are nested under `function`, the model returns `tool_calls` on an assistant message, and tool results go back as `role: "tool"` messages.

#### Step 1: Inference Request with Tools

```json expandable lines theme={null}
{
  "model": "google/gemini-3-flash-preview",
  "messages": [
    {
      "role": "user",
      "content": "What are the titles of some James Joyce books?"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search_gutenberg_books",
        "description": "Search for books in the Project Gutenberg library",
        "parameters": {
          "type": "object",
          "properties": {
            "search_terms": {
              "type": "array",
              "items": {"type": "string"},
              "description": "List of search terms to find books"
            }
          },
          "required": ["search_terms"]
        }
      }
    }
  ]
}
```

#### Step 2: Tool Execution (Client-Side)

After receiving the model's response with `tool_calls`, execute the requested tool locally and prepare the result:

```javascript lines theme={null}
// Model responds with tool_calls, you execute the tool locally
const toolResult = await searchGutenbergBooks(["James", "Joyce"]);
```

#### Step 3: Inference Request with Tool Results

```json expandable lines theme={null}
{
  "model": "google/gemini-3-flash-preview",
  "messages": [
    {
      "role": "user",
      "content": "What are the titles of some James Joyce books?"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": {
            "name": "search_gutenberg_books",
            "arguments": "{\"search_terms\": [\"James\", \"Joyce\"]}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "[{\"id\": 4300, \"title\": \"Ulysses\", \"authors\": [{\"name\": \"Joyce, James\"}]}]"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search_gutenberg_books",
        "description": "Search for books in the Project Gutenberg library",
        "parameters": {
          "type": "object",
          "properties": {
            "search_terms": {
              "type": "array",
              "items": {"type": "string"},
              "description": "List of search terms to find books"
            }
          },
          "required": ["search_terms"]
        }
      }
    }
  ]
}
```

**Note**: On both APIs, the `tools` parameter must be included in every request (Steps 1 and 3) so the router can validate the tool schema on each call.

### Tool Calling Example

Here is an end-to-end example that gives LLMs the ability to call an external API -- in this case Project Gutenberg, to search for books.

First, let's do some basic setup:

```typescript title="TypeScript SDK" expandable lines theme={null}
import type {
  FunctionCallOutputItem,
  InputsUnion1,
  OpenAIResponsesRefusalContent,
  OpenResponsesResult,
  OutputFunctionCallItem,
  OutputMessageItem,
  OutputReasoningItem,
  ResponseOutputText,
  ResponsesRequestToolFunction,
} from '@openrouter/sdk/models';
import { OpenRouter } from '@openrouter/sdk';

const OPENROUTER_API_KEY = "<OPENROUTER_API_KEY>";

// You can use any model that supports tool calling
const MODEL = "google/gemini-3-flash-preview";

const openRouter = new OpenRouter({
  apiKey: OPENROUTER_API_KEY,
});

const instructions = "You are a helpful assistant.";
const task = "What are the titles of some James Joyce books?";

const input: InputsUnion1[] = [
  {
    role: "user",
    content: task,
  }
];

function convertOutputItemToInput(
  item: OpenResponsesResult['output'][number],
): InputsUnion1 {
  if (isOutputMessageItem(item)) {
    const content = item.content.filter(isKnownMessageContent);
    if (content.length !== item.content.length) {
      throw new Error('Received an unsupported message content type');
    }
    return { ...item, content };
  }

  if (isFunctionCallOrReasoningItem(item)) {
    return item;
  }

  throw new Error(`Received an unexpected output item: ${item.type}`);
}

function isOutputMessageItem(
  item: OpenResponsesResult['output'][number],
): item is OutputMessageItem {
  return item.type === 'message';
}

function isKnownMessageContent(
  content: OutputMessageItem['content'][number],
): content is OpenAIResponsesRefusalContent | ResponseOutputText {
  return content.type === 'output_text' || content.type === 'refusal';
}

function isFunctionCallOrReasoningItem(
  item: OpenResponsesResult['output'][number],
): item is OutputFunctionCallItem | OutputReasoningItem {
  return item.type === 'function_call' || item.type === 'reasoning';
}
```

```python Python expandable lines theme={null}
import json, requests
from openai import OpenAI

OPENROUTER_API_KEY = f"<OPENROUTER_API_KEY>"

# You can use any model that supports tool calling
MODEL = "google/gemini-3-flash-preview"

openai_client = OpenAI(
  base_url="https://openrouter.ai/api/v1",
  api_key=OPENROUTER_API_KEY,
)

instructions = "You are a helpful assistant."
task = "What are the titles of some James Joyce books?"

input_items = [
  {
    "role": "user",
    "content": task,
  }
]

```

```typescript title="TypeScript (fetch)" lines theme={null}
const instructions = 'You are a helpful assistant.';

const input: unknown[] = [
  {
    role: 'user',
    content: 'What are the titles of some James Joyce books?',
  },
];
```

### Define the Tool

Next, we define the tool that we want to call. Remember, the tool is going to get *requested* by the LLM, but the code we are writing here is ultimately responsible for executing the call and returning the results to the LLM.

```typescript title="TypeScript SDK" expandable lines theme={null}
type Book = {
  id: number;
  title: string;
  authors: { name: string }[];
};

async function searchGutenbergBooks(searchTerms: string[]): Promise<Book[]> {
  const searchQuery = searchTerms.join(' ');
  const url = 'https://gutendex.com/books';
  const response = await fetch(`${url}?search=${searchQuery}`);
  const data: unknown = await response.json();

  if (!isGutenbergResponse(data)) {
    throw new Error('Invalid response from the Gutenberg API');
  }

  return data.results.map((book) => ({
    id: book.id,
    title: book.title,
    authors: book.authors.map((author) => ({ name: author.name })),
  }));
}

const tools: ResponsesRequestToolFunction[] = [
  {
    type: 'function',
    name: 'searchGutenbergBooks',
    description:
      'Search for books in the Project Gutenberg library based on specified search terms',
    parameters: {
      type: 'object',
      properties: {
        search_terms: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            "List of search terms to find books in the Gutenberg library (e.g. ['dickens', 'great'] to search for books by Dickens with 'great' in the title)",
        },
      },
      required: ['search_terms'],
    },
  },
];

function parseSearchTerms(argumentsJson: string): string[] {
  const args: unknown = JSON.parse(argumentsJson);

  if (
    !isRecord(args) ||
    !isStringArray(args.search_terms)
  ) {
    throw new Error('Invalid arguments for searchGutenbergBooks');
  }

  return args.search_terms;
}

function isGutenbergResponse(value: unknown): value is { results: Book[] } {
  return isRecord(value) && Array.isArray(value.results) && value.results.every(isBook);
}

function isBook(value: unknown): value is Book {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.title === 'string' &&
    Array.isArray(value.authors) &&
    value.authors.every(isBookAuthor)
  );
}

function isBookAuthor(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
```

```python Python expandable lines theme={null}
def search_gutenberg_books(search_terms):
    search_query = " ".join(search_terms)
    url = "https://gutendex.com/books"
    response = requests.get(url, params={"search": search_query})

    simplified_results = []
    for book in response.json().get("results", []):
        simplified_results.append({
            "id": book.get("id"),
            "title": book.get("title"),
            "authors": book.get("authors")
        })

    return simplified_results

tools = [
  {
    "type": "function",
    "name": "search_gutenberg_books",
    "description": "Search for books in the Project Gutenberg library based on specified search terms",
    "parameters": {
      "type": "object",
      "properties": {
        "search_terms": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "List of search terms to find books in the Gutenberg library (e.g. ['dickens', 'great'] to search for books by Dickens with 'great' in the title)"
        }
      },
      "required": ["search_terms"]
    }
  }
]

TOOL_MAPPING = {
    "search_gutenberg_books": search_gutenberg_books
}

```

```typescript title="TypeScript (fetch)" expandable lines theme={null}
type Book = { id: number; title: string; authors: { name: string }[] };

async function searchGutenbergBooks(searchTerms: string[]): Promise<Book[]> {
  const query = encodeURIComponent(searchTerms.join(' '));
  const response = await fetch(`https://gutendex.com/books?search=${query}`);
  const data = await response.json();
  return data.results.map((book: Book) => ({
    id: book.id,
    title: book.title,
    authors: book.authors,
  }));
}

const tools = [
  {
    type: 'function',
    name: 'search_gutenberg_books',
    description:
      'Search for books in the Project Gutenberg library based on specified search terms',
    parameters: {
      type: 'object',
      properties: {
        search_terms: {
          type: 'array',
          items: { type: 'string' },
          description:
            "List of search terms to find books in the Gutenberg library (e.g. ['dickens', 'great'] to search for books by Dickens with 'great' in the title)",
        },
      },
      required: ['search_terms'],
    },
  },
];
```

Note that the "tool" is just a normal function. We then write a JSON "spec" compatible with the OpenAI function calling parameter. We'll pass that spec to the LLM so that it knows this tool is available and how to use it. It will request the tool when needed, along with any arguments. We'll then marshal the tool call locally, make the function call, and return the results to the LLM.

### Tool use and tool results

Let's make the first OpenRouter API call to the model:

```typescript title="TypeScript SDK" lines theme={null}
const response_1 = await openRouter.responses.send({
  responsesRequest: {
    model: MODEL,
    instructions,
    tools,
    input,
    stream: false,
  },
});

if (!('output' in response_1)) {
  throw new Error('Expected a non-streaming response');
}
```

```python Python lines theme={null}
request_1 = {
    "model": MODEL,
    "instructions": instructions,
    "tools": tools,
    "input": input_items
}

response_1 = openai_client.responses.create(**request_1)
```

```typescript title="TypeScript (fetch)" lines theme={null}
const request_1 = await fetch('https://openrouter.ai/api/v1/responses', {
  method: 'POST',
  headers: {
    Authorization: `Bearer <OPENROUTER_API_KEY>`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    instructions,
    tools,
    input,
  }),
});

const data_1 = await request_1.json();
```

`response.output` contains `function_call` items with a `call_id`, `name`, and JSON-encoded `arguments`. Production code should verify that at least one exists; this example assumes one does:

```typescript title="TypeScript SDK" lines theme={null}
const toolCalls = response_1.output.filter(
  (item): item is OutputFunctionCallItem => item.type === 'function_call',
);

if (toolCalls.length === 0) {
  throw new Error('Expected the model to request a tool call');
}

// Append every output item in order so the LLM has the full context.
// It's easy to forget this step!
input.push(...response_1.output.map(convertOutputItemToInput));

// Now we process the requested tool calls, and use our book lookup tool
for (const toolCall of toolCalls) {
  if (toolCall.name !== 'searchGutenbergBooks') {
    throw new Error(`Unknown tool: ${toolCall.name}`);
  }

  const searchTerms = parseSearchTerms(toolCall.arguments);
  const toolResponse = await searchGutenbergBooks(searchTerms);
  input.push({
    type: 'function_call_output',
    callId: toolCall.callId,
    output: JSON.stringify(toolResponse),
  });
}
```

```python Python lines theme={null}
# Append the model's output items to the input array so the LLM has the full context
# It's easy to forget this step!
input_items += response_1.output

# Now we process the requested tool calls, and use our book lookup tool
for item in response_1.output:
    if item.type != "function_call":
        continue
    '''
    In this case we only provided one tool, so we know what function to call.
    When providing multiple tools, you can inspect `item.name`
    to figure out what function you need to call locally.
    '''
    tool_name = item.name
    tool_args = json.loads(item.arguments)
    tool_response = TOOL_MAPPING[tool_name](**tool_args)
    input_items.append({
      "type": "function_call_output",
      "call_id": item.call_id,
      "output": json.dumps(tool_response),
    })
```

```typescript title="TypeScript (fetch)" lines theme={null}
const toolCalls = data_1.output.filter(
  (item: { type: string }) => item.type === 'function_call',
);

// Carry every output item forward in order so the model has the full context
// It's easy to forget this step!
const input_2 = [
  ...input,
  ...data_1.output,
];

// Now we process the requested tool calls, and use our book lookup tool
for (const toolCall of toolCalls) {
  if (toolCall.name !== 'search_gutenberg_books') {
    throw new Error(`Unknown tool: ${toolCall.name}`);
  }

  const { search_terms } = JSON.parse(toolCall.arguments);
  const toolResponse = await searchGutenbergBooks(search_terms);
  input_2.push({
    type: 'function_call_output',
    call_id: toolCall.call_id,
    output: JSON.stringify(toolResponse),
  });
}
```

The input array now has:

1. Our original request
2. The LLM's reasoning items, when present, and `function_call` items
3. A `function_call_output` item with the tool result

Now, we can make a second OpenRouter API call, and hopefully get our result!

```typescript title="TypeScript SDK" lines theme={null}
const response_2 = await openRouter.responses.send({
  responsesRequest: {
    model: MODEL,
    instructions,
    input,
    tools,
    stream: false,
  },
});

if (!('output' in response_2)) {
  throw new Error('Expected a non-streaming response');
}

const finalMessage = [...response_2.output].reverse().find((item) => item.type === 'message');
console.log(finalMessage?.content.find((part) => part.type === 'output_text')?.text);
```

```python Python lines theme={null}
request_2 = {
  "model": MODEL,
  "instructions": instructions,
  "input": input_items,
  "tools": tools
}

response_2 = openai_client.responses.create(**request_2)

print(response_2.output_text)
```

```typescript title="TypeScript (fetch)" lines theme={null}
const response = await fetch('https://openrouter.ai/api/v1/responses', {
  method: 'POST',
  headers: {
    Authorization: `Bearer <OPENROUTER_API_KEY>`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    instructions,
    input: input_2,
    tools,
  }),
});

const data = await response.json();
const message = [...data.output].reverse().find((item: { type: string }) => item.type === 'message');
console.log(message?.content.find((part: { type: string; text?: string }) => part.type === 'output_text')?.text);
```

The output will be something like:

```text lines theme={nul! 