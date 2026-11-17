// src/worker.mjs
import { DurableObject } from "cloudflare:workers";

// src/nsm.mjs - Neuro Symbolic Model Layer
var NSM_CLASS = class {
  constructor(kv) {
    this.kv = kv;
  }
  async getDomainIndex() {
    if (!this.kv) return { domains: [] };
    return await this.kv.get("DOMAIN:index", { type: "json" }) || { domains: [] };
  }
  async putDomainIndex(idx) {
    if (this.kv) await this.kv.put("DOMAIN:index", JSON.stringify(idx));
  }
  async getDomainPatterns(domain) {
    if (!this.kv) return [];
    return await this.kv.get(`DOMAIN:${domain}:patterns`, { type: "json" }) || [];
  }
  async putDomainPatterns(domain, patterns) {
    if (this.kv) await this.kv.put(`DOMAIN:${domain}:patterns`, JSON.stringify(patterns));
  }
  async getDomainPrinciples(domain) {
    if (!this.kv) return [];
    return await this.kv.get(`DOMAIN:${domain}:principles`, { type: "json" }) || [];
  }
  async putDomainPrinciples(domain, principles) {
    if (this.kv) await this.kv.put(`DOMAIN:${domain}:principles`, JSON.stringify(principles));
  }
  async getDomainConfidence(domain) {
    if (!this.kv) return 0;
    const rec = await this.kv.get(`DOMAIN:${domain}:confidence`, { type: "json" });
    return rec ? rec.score : 0;
  }
  async putDomainConfidence(domain, score) {
    if (this.kv) await this.kv.put(`DOMAIN:${domain}:confidence`, JSON.stringify({ score, ts: Date.now() }));
  }
  async getRecallLog(domain) {
    if (!this.kv) return [];
    return await this.kv.get(`DOMAIN:${domain}:recall`, { type: "json" }) || [];
  }
  async appendRecallLog(domain, entry) {
    if (!this.kv) return;
    const log = await this.getRecallLog(domain);
    log.push({ ...entry, ts: Date.now() });
    if (log.length > 200) log.splice(0, log.length - 200);
    await this.kv.put(`DOMAIN:${domain}:recall`, JSON.stringify(log));
  }
  extractPatterns(text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const words = lower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    const terms = Object.entries(freq).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([value, frequency]) => ({ type: "term", value, frequency }));
    const bigrams = [];
    for (let i = 0; i < words.length - 1; i++) {
      const bg = words[i] + " " + words[i + 1];
      freq[bg] = (freq[bg] || 0) + 1;
    }
    for (const [bg, c] of Object.entries(freq)) {
      if (bg.includes(" ") && c >= 2) bigrams.push({ type: "bigram", value: bg, frequency: c });
    }
    bigrams.sort((a, b) => b.frequency - a.frequency);
    return [...terms, ...bigrams.slice(0, 15)];
  }
  async checkCache(patterns) {
    const idx = await this.getDomainIndex();
    const hits = [];
    const allCachedPatterns = [];
    for (const domain of idx.domains) {
      const dp = await this.getDomainPatterns(domain);
      allCachedPatterns.push(...dp.map(p => ({ ...p, domain })));
    }
    for (const pat of patterns) {
      const match = allCachedPatterns.find(cp => cp.value === pat.value);
      if (match) hits.push({ pattern: pat, domain: match.domain });
    }
    return { hits, domains: idx.domains, allCachedPatterns };
  }
  buildConsensus(patterns, cacheHits) {
    if (patterns.length === 0) return { score: 0, domainVotes: {} };
    const domainVotes = {};
    for (const hit of cacheHits) {
      domainVotes[hit.domain] = (domainVotes[hit.domain] || 0) + 1;
    }
    const matchRatio = cacheHits.length / patterns.length;
    let topDomain = null;
    let topVotes = 0;
    for (const [d, v] of Object.entries(domainVotes)) {
      if (v > topVotes) { topDomain = d; topVotes = v; }
    }
    const score = topDomain ? (topVotes / patterns.length) * (topVotes >= 3 ? 1 : 0.5) : matchRatio;
    return { score, topDomain, domainVotes };
  }
  async acquireDomain(domainName, principles) {
    const idx = await this.getDomainIndex();
    if (!idx.domains.includes(domainName)) {
      idx.domains.push(domainName);
      await this.putDomainIndex(idx);
    }
    if (principles && principles.length > 0) {
      const existing = await this.getDomainPrinciples(domainName);
      const merged = [...existing];
      for (const p of principles) {
        const txt = typeof p === "string" ? p : p.text || "";
        if (txt && !merged.some(e => (typeof e === "string" ? e : e.text) === txt)) {
          merged.push(p);
        }
      }
      await this.putDomainPrinciples(domainName, merged);
    }
  }
  async enrichMessages(messages, domain, principles) {
    if (!domain || !principles || principles.length === 0) return { messages, domainApplied: false };
    const principleList = principles.map(p => typeof p === "string" ? p : p.text || "").filter(Boolean).join("; ");
    const enriched = messages.map(m => ({ ...m }));
    const sysIdx = enriched.findIndex(m => m.role === "system");
    if (sysIdx >= 0) {
      enriched[sysIdx] = {
        ...enriched[sysIdx],
        content: enriched[sysIdx].content + "\n\n[NSM Domain: " + domain + " | Principles: " + principleList + "]"
      };
    } else {
      enriched.unshift({ role: "system", content: "[NSM Domain: " + domain + " | Principles: " + principleList + "]" });
    }
    return { messages: enriched, domainApplied: true };
  }
  async wrap(messages, task, context = {}) {
    const text = messages.map(m => m.content || "").join(" ");
    const patterns = this.extractPatterns(text);
    const cache = await this.checkCache(patterns);
    const consensus = this.buildConsensus(patterns, cache.hits);
    let domain = context.domain || consensus.topDomain || "general";
    let principles = await this.getDomainPrinciples(domain);
    let domainCreated = false;
    if (consensus.score >= 0.3 && domain !== "general" && principles.length === 0) {
      await this.acquireDomain(domain, []);
      domainCreated = true;
    }
    const prevConf = await this.getDomainConfidence(domain);
    const newConf = Math.min(1, prevConf + (consensus.score * 0.1));
    await this.putDomainConfidence(domain, newConf);
    const { messages: enriched, domainApplied } = await this.enrichMessages(messages, domain, principles);
    const needsExpert = newConf < 0.2 && patterns.length > 5;
    await this.appendRecallLog(domain, {
      task,
      patternCount: patterns.length,
      cacheHitCount: cache.hits.length,
      consensusScore: consensus.score,
      domainApplied,
      needsExpert
    });
    return {
      messages: enriched,
      metadata: {
        domain,
        domainApplied,
        domainCreated,
        confidence: newConf,
        consensusScore: consensus.score,
        patternCount: patterns.length,
        cacheHitCount: cache.hits.length,
        principleCount: principles.length,
        needsExpert,
        topPatterns: patterns.slice(0, 8)
      }
    };
  }
  async postProcess(responseText, domain, task) {
    if (!responseText || domain === "general") return;
    const newPatterns = this.extractPatterns(responseText);
    if (newPatterns.length === 0) return;
    const existing = await this.getDomainPatterns(domain);
    const merged = [...existing];
    for (const p of newPatterns) {
      if (!merged.some(e => e.value === p.value)) merged.push(p);
    }
    if (merged.length > 300) merged.splice(0, merged.length - 300);
    await this.putDomainPatterns(domain, merged);
  }
  async listDomains() {
    const idx = await this.getDomainIndex();
    const domains = [];
    for (const d of idx.domains) {
      const principles = await this.getDomainPrinciples(d);
      const patterns = await this.getDomainPatterns(d);
      const conf = await this.getDomainConfidence(d);
      domains.push({ name: d, principleCount: principles.length, patternCount: patterns.length, confidence: conf, principles, patterns: patterns.slice(0, 20) });
    }
    return domains;
  }
};

// src/llm-router.mjs
var CF_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
var OPENROUTER_MODEL = "@preset/truth";
var TASK_BACKEND = {
  classify: "cf",
  ocr: "cf",
  compliance: "cf",
  proposePrinciples: "cf",
  instruct_simple: "cf",
  instruct_complex: "openrouter",
  deepQuery: "openrouter",
  deepAudit: "openrouter",
  analyzeGap: "openrouter",
  generate: "openrouter"
};
var LLMRouter = class {
  constructor(cfAI, openrouterKey, openrouterBaseUrl = "https://openrouter.ai/api/v1", nsm = null, orproxy = null) {
    this.cfAI = cfAI;
    this.openrouterKey = openrouterKey;
    this.openrouterBaseUrl = openrouterBaseUrl;
    this.nsm = nsm;
    this.orproxy = orproxy;
  }
  async callCfAI(messages, options = {}) {
    const response = await this.cfAI.run(CF_AI_MODEL, {
      messages,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature ?? 0.3,
      stream: false
    });
    return response?.response || "";
  }
  async callOpenRouter(messages, options = {}) {
    const body = JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.3,
      stream: false
    });
    let response;
    if (this.orproxy && typeof this.orproxy.fetch === "function") {
      response = await this.orproxy.fetch("https://orproxy/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
    } else if (this.openrouterKey) {
      response = await fetch(`${this.openrouterBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.openrouterKey}`,
          "Content-Type": "application/json"
        },
        body
      });
    } else {
      throw new Error("No OpenRouter route configured (ORPROXY binding and OPENROUTER_API_KEY are both missing)");
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
      }
      throw new Error(`OpenRouter upstream ${response.status}${detail ? ": " + detail : ""}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("OpenRouter returned no completion content");
    }
    return content;
  }
  async call(task, messages, options = {}) {
    let nsmMeta = null;
    if (this.nsm) {
      const wrapped = await this.nsm.wrap(messages, task, options.context || {});
      messages = wrapped.messages;
      nsmMeta = wrapped.metadata;
    }
    const backend = TASK_BACKEND[task] || "cf";
    let result = "";
    try {
      if (backend === "cf") {
        result = await this.callCfAI(messages, options);
      } else {
        result = await this.callOpenRouter(messages, options);
      }
    } catch (err) {
      const fallback = backend === "cf" ? "openrouter" : "cf";
      try {
        if (fallback === "openrouter") {
          result = await this.callOpenRouter(messages, options);
        } else {
          result = await this.callCfAI(messages, options);
        }
      } catch (fallbackErr) {
        throw new Error(`LLM backend failed: ${err.message}, fallback also failed: ${fallbackErr.message}`);
      }
    }
    if (this.nsm && result && nsmMeta) {
      await this.nsm.postProcess(result, nsmMeta.domain, task);
    }
    if (nsmMeta) options._nsmMeta = nsmMeta;
    return result;
  }
  async classify(content, domainHints = []) {
    const prompt = [
      { role: "system", content: 'You are a domain classifier. Given content, return a JSON object with "domain" (one of: general, legal, educational, medical, technical) and "principles" (array of 1-3 concise principle statements that should govern this content). Return ONLY valid JSON, no markdown.' },
      { role: "user", content: `Classify this content and propose governing principles:

${content.slice(0, 3e3)}` }
    ];
    const raw = await this.call("classify", prompt);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { domain: "general", principles: [] };
    }
  }
  async ocr(bytes, mimeType) {
    const input = { image: [...new Uint8Array(bytes)] };
    const response = await this.cfAI.run(CF_AI_MODEL, {
      messages: [
        { role: "system", content: "Extract all visible text from this image. Return only the text, no commentary." }
      ],
      ...input
    });
    return response?.response || "";
  }
  async checkCompliance(content, principles) {
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text}`).join("\n");
    const prompt = [
      { role: "system", content: 'You are a compliance checker. Given content and a list of principles, check if the content complies with each principle. Return a JSON object with "violations" (array of {principleIndex, description}) and "suggestions" (array of {principleIndex, suggestion}). Return ONLY valid JSON.' },
      { role: "user", content: `Content:
${content.slice(0, 3e3)}

Principles:
${principleList}` }
    ];
    const raw = await this.call("compliance", prompt);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { violations: [], suggestions: [] };
    }
  }
  async proposePrinciples(content, domain) {
    const prompt = [
      { role: "system", content: `You are a principle proposal engine for the "${domain}" domain. Given content, propose 2-4 concise governing principles that should be extracted and ratified. Each principle should be a clear, actionable constraint. Return a JSON array of objects with "text" (the principle statement) and "rationale" (why this principle matters). Return ONLY valid JSON.` },
      { role: "user", content: `Extract governing principles from this ${domain} content:

${content.slice(0, 3e3)}` }
    ];
    const raw = await this.call("proposePrinciples", prompt);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return [];
    }
  }
  async routeInstruct(prompt, principles, isComplex = false) {
    const task = isComplex ? "instruct_complex" : "instruct_simple";
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text}`).join("\n");
    const messages = [
      { role: "system", content: `You are a domain-bound generation engine. Generate output that strictly adheres to the following governing principles:

${principleList}

If the output would violate any principle, refuse and explain why.` },
      { role: "user", content: prompt }
    ];
    return await this.call(task, messages);
  }
  async deepQuery(query, principles, cards) {
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text} [weight: ${p.confidenceWeight}]`).join("\n");
    const cardList = cards.map((c, i) => `[Card ${i + 1}] (${c.type}) ${c.title}: ${c.content?.slice(0, 500) || ""}`).join("\n");
    const messages = [
      { role: "system", content: `You are a truth-engine query processor. Given a query, governing principles, and workspace content, rank relevant results by relevance and principle alignment. Return a JSON array of objects with "sourceType" (principle|card), "sourceId", "relevance" (0-1), "snippet" (relevant excerpt), "confidence" ({base, total}). Return ONLY valid JSON.` },
      { role: "user", content: `Query: ${query}

Active Principles:
${principleList}

Workspace Content:
${cardList}` }
    ];
    const raw = await this.call("deepQuery", messages);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return [];
    }
  }
  async deepAudit(cards, principles, scope) {
    const principleList = principles.map((p, i) => `[${i + 1}] (${p.domainTag}) ${p.text} [weight: ${p.confidenceWeight}]`).join("\n");
    const cardList = cards.map((c, i) => `[Card ${i + 1}] (${c.type}) ${c.title}:
${c.content?.slice(0, 1e3) || "(empty)"}`).join("\n\n");
    const scopeDesc = scope === "full" ? "Perform a comprehensive analysis including citation verification, structural completeness, and logical consistency." : "Perform a compliance-only check against the principles.";
    const messages = [
      { role: "system", content: `You are a truth-engine audit system. Audit the following cards against the governing principles. ${scopeDesc}

Return a JSON object with:
- "findings": array of {cardId, severity (info|warning|violation), principleId, principleText, description, suggestion, confidence (0-1)}
- "principleCoverage": {total, satisfied, violated, unaddressed}
- "overallConfidence": 0-1
- "status": "pass"|"conditional"|"fail"

Return ONLY valid JSON.` },
      { role: "user", content: `Cards to audit:

${cardList}

Governing Principles:
${principleList}` }
    ];
    const raw = await this.call("deepAudit", messages);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { findings: [], principleCoverage: { total: principles.length, satisfied: 0, violated: 0, unaddressed: principles.length }, overallConfidence: 0, status: "fail" };
    }
  }
  async analyzeGap(baseScore, expertScore, cardContent) {
    const messages = [
      { role: "system", content: 'You are a gap analyst. Given a BASE confidence score, an expert-adjusted score, and the card content, explain why the expert judged differently. Return a JSON object with "explanation", "keyFactors" (array), and "learningPoint" (what the system should learn). Return ONLY valid JSON.' },
      { role: "user", content: `BASE score: ${baseScore}
Expert score: ${expertScore}
Differential: ${expertScore - baseScore}

Card content:
${cardContent?.slice(0, 2e3) || "(empty)"}` }
    ];
    const raw = await this.call("analyzeGap", messages);
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { explanation: "Gap analysis unavailable", keyFactors: [], learningPoint: "" };
    }
  }
};

// src/domains.mjs
// A comparison is a read of two other Workers. It writes nothing, so it stores
// nothing; it is gated on ADMIN_KEY because an unset key must mean closed.
function compareHead(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 90);
}
function compareVerdict(a, b) {
  if (!a || !b) return "one side returned nothing";
  if (a.error || b.error) return "one side errored";
  if (a.clarify && b.clarify) return "agree — both ask";
  if (a.clarify !== b.clarify) return a.clarify ? "differ — mind asks, cods answers" : "differ — cods asks, mind answers";
  if (a.cacheSource || b.cacheSource) {
    if (a.cacheSource && a.cacheSource === b.cacheSource) return "agree — both from " + a.cacheSource;
    return "differ — mind " + (a.cacheSource || "generated") + ", cods " + (b.cacheSource || "generated");
  }
  return a.head && a.head === b.head ? "agree — same answer" : "differ — different answers";
}
async function readMindAsk(ask) {
  try {
    const res = await fetch("https://mind.ai-n.workers.dev/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: ask }], stream: true }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok || !res.body) return { app: "mind", error: "status_" + res.status };
    const text = await res.text();
    let meta = null;
    let answer = "";
    let clarify = false;
    let question = null;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data: ")) continue;
      const raw = t.slice(6);
      if (!raw || raw === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(raw); } catch (err) { continue; }
      if (ev.type === "meta") meta = ev;
      else if (ev.type === "delta") answer += ev.text || "";
      else if (ev.type === "clarify") { clarify = true; question = (ev.question && ev.question.q) || null; }
    }
    const dec = (meta && meta.decision) || {};
    return {
      app: "mind",
      route: (meta && meta.route) || null,
      model: (meta && meta.model) || null,
      cacheSource: dec.cacheSource || null,
      move: (dec.ara && dec.ara.move) || null,
      clarify: clarify,
      question: question,
      chars: answer.length,
      head: compareHead(answer),
    };
  } catch (err) {
    return { app: "mind", error: String((err && err.message) || err) };
  }
}
async function readCodsAsk(ask) {
  try {
    const res = await fetch("https://cods.ai-n.workers.dev/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: ask }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return { app: "cods", error: "status_" + res.status };
    const d = await res.json();
    const qs = (d.clarify && d.clarify.questions) || [];
    const answer = String(d.answer || "");
    return {
      app: "cods",
      route: d.route || null,
      model: d.provider || null,
      cacheSource: d.cacheSource || (d.source === "cache" ? d.cacheSource || "cache" : null),
      move: (d.ara && d.ara.move) || null,
      clarify: qs.length > 0,
      question: qs[0] ? qs[0].q || null : null,
      chars: answer.length,
      head: compareHead(answer),
    };
  } catch (err) {
    return { app: "cods", error: String((err && err.message) || err) };
  }
}

var DOMAINS = {
  general: { label: "General", tier: "base", color: "#888" },
  legal: { label: "Legal", tier: "domain", color: "#4ab8ff" },
  educational: { label: "Education", tier: "domain", color: "#8aff4a" },
  medical: { label: "Medical", tier: "domain", color: "#ff4a8a" },
  technical: { label: "Technical", tier: "domain", color: "#c14aff" }
};
var DOMAIN_LIST = Object.keys(DOMAINS);
function isValidDomain(domain) {
  return domain in DOMAINS;
}
var KvKeys = {
  principles: (d) => `domain:${d}:principles`,
  stack: (d) => `domain:${d}:stack`,
  searchCache: (d, hash) => `domain:${d}:search:${hash}`,
  queryCache: (d, qid) => `domain:${d}:query:${qid}`,
  auditCache: (d, aid) => `domain:${d}:audit:${aid}`,
  registry: () => "domains:registry",
  domainStats: (d) => `domain:${d}:stats`
};
var R2Paths = {
  import: (domain, id, file) => `${domain}/imports/${id}/${file}`,
  snapshot: (domain, cardId, ts) => `${domain}/snapshots/${cardId}/${ts}`,
  template: (domain, tid) => `${domain}/templates/${tid}`,
  export: (domain, wsId) => `${domain}/exports/${wsId}.json`,
  listPrefix: (domain, type) => `${domain}/${type}/`
};
function createDomainStack(primary = "general", secondary = [], sourceCardId = null) {
  return {
    primary: isValidDomain(primary) ? primary : "general",
    secondary: secondary.filter(isValidDomain),
    activatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sourceCardId
  };
}
function getActiveDomains(stack) {
  if (!stack) return ["general"];
  return [stack.primary, ...stack.secondary || []];
}

// src/worker.mjs
var INDEX_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Truth Engine — Workspace</title>
  <style>
    :root {
      --canvas: #0f1115; --panel: #171a20; --raised: #1e222a;
      --border: #2a2f38; --border-strong: #3a414d;
      --text: #e6e9ef; --muted: #9aa4b2; --dim: #6f7885;
      --accent: #4a9eff; --accent-soft: #4a9eff22;
      --ok: #46b17b; --warn: #d9a441; --bad: #d9534f;
      --radius: 5px;
      --mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace;
      --ui: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      --z-panel: 60; --z-modal: 120; --z-toast: 200;
    }
    /* The utility classes the markup already uses, defined locally. No external stylesheet. */
    .flex { display: flex; }
    .items-center { align-items: center; }
    .justify-end { justify-content: flex-end; }
    .justify-between { justify-content: space-between; }
    .gap-2 { gap: 8px; }
    .flex-1 { flex: 1 1 0%; min-width: 0; }
    .mb-3 { margin-bottom: 12px; }
    .mb-4 { margin-bottom: 16px; }
    .text-xs { font-size: 12px; }
    .text-sm { font-size: 13px; }
    .text-lg { font-size: 18px; }
    .font-bold { font-weight: 600; }
    .rounded { border-radius: var(--radius); }
    .border { border: 1px solid var(--border); }
    .border-slate-800 { border-color: var(--border); }
    .bg-slate-950 { background: var(--canvas); }
    .text-gray-400 { color: var(--muted); }
    .text-gray-500 { color: var(--dim); }
    /* Base reset: what the Tailwind preflight used to give every unstyled control. */
    *, *::before, *::after { box-sizing: border-box; }
    h1, h2, h3, h4, h5, h6, p, figure, blockquote, dl, dd { margin: 0; }
    button, input, select, textarea { font: inherit; color: inherit; letter-spacing: inherit; }
    button { background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
    button:hover { border-color: var(--border-strong); }
    input, select, textarea { background: var(--canvas); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
    select { cursor: pointer; }
    input[type="checkbox"] { width: auto; accent-color: var(--accent); }
    table { border-collapse: collapse; }
    img, svg, video, canvas { display: block; max-width: 100%; }
    /* The remaining utilities the markup uses. */
    .bg-transparent { background: transparent; }
    .text-white { color: #fff; }
    .font-semibold { font-weight: 600; }
    .outline-none { outline: none; }
    .w-full { width: 100%; }
    .text-center { text-align: center; }
    .ml-1 { margin-left: 4px; }
    .ml-2 { margin-left: 8px; }
    .mb-2 { margin-bottom: 8px; }
    .mt-2 { margin-top: 8px; }
    .p-2 { padding: 8px; }
    .p-3 { padding: 12px; }
    .p-6 { padding: 24px; }
    .text-slate-400 { color: var(--muted); }
    .text-slate-500 { color: var(--dim); }
    .border-slate-700 { border-color: var(--border-strong); }
    .border-2 { border-width: 2px; }
    .border-dashed { border-style: dashed; }
    .text-red-400 { color: #f2777a; }
    .text-red-300 { color: #f5a0a2; }
    .text-yellow-400 { color: var(--warn); }
    .text-yellow-300 { color: #e8c07a; }
    .text-green-400 { color: var(--ok); }
    .text-cyan-300 { color: #7fd4e0; }
    [class~="hover:text-blue-400"]:hover { color: var(--accent); }
    [class~="hover:text-red-400"]:hover { color: #f2777a; }
    body { background: var(--canvas); color: var(--text); font-family: var(--ui); font-size: 13px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .card-window { position: absolute; min-width: 160px; max-width: 760px; container-type: inline-size; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 10px 28px rgba(0,0,0,0.45); transition: border-color .12s, box-shadow .12s; display: flex; flex-direction: column; overflow: hidden; }
    .card-window.browser-card { max-width: 760px; min-width: 240px; }
    .card-window:hover { border-color: var(--border-strong); box-shadow: 0 12px 32px rgba(0,0,0,0.55); }
    .card-header { cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; padding: 0 6px; height: 38px; gap: 4px; overflow: hidden; background: var(--raised); border-radius: var(--radius) var(--radius) 0 0; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
    .card-header:active { cursor: grabbing; }
    .card-header > .flex-1 { min-width: 0; }
    .card-header .card-title { min-width: 0; }
    /* A tile small enough for six on screen keeps its own controls: the badge and the
       domain picker are the first things to go, never the close button. */
    @container (max-width: 250px) {
      .card-header .card-type-badge, .card-header select { display: none; }
    }
    .card-type-badge { font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
    .badge-browser { background: #1a4a6a; color: #4ab8ff; }
    .badge-document { background: #2a3a1a; color: #8aff4a; }
    .badge-instruct { background: #4a2a1a; color: #ff8a4a; }
    .badge-import { background: #3a1a4a; color: #c14aff; }
    .badge-search { background: #1a3a3a; color: #4affc8; }
    .badge-query { background: #1a2a4a; color: #4a9fff; }
    .badge-audit { background: #4a1a2a; color: #ff4a6a; }
    .badge-domain { background: #2a2a1a; color: #c8c84a; }
    .audit-pass { border-left: 3px solid #4aff8a; }
    .audit-conditional { border-left: 3px solid #ffaa4a; }
    .audit-fail { border-left: 3px solid #ff4a4a; }
    .audit-finding { padding: 6px 8px; margin: 4px 0; background: #0d0d1a; border-radius: 4px; font-size: 11px; border-left: 2px solid #2a2a4a; }
    .audit-finding.violation { border-left-color: #ff4a4a; }
    .audit-finding.warning { border-left-color: #ffaa4a; }
    .audit-finding.info { border-left-color: #4a9fff; }
    .audit-coverage { display: flex; gap: 12px; padding: 6px 0; font-size: 11px; }
    .audit-coverage .cov-item { display: flex; align-items: center; gap: 4px; }
    .audit-coverage .cov-dot { width: 8px; height: 8px; border-radius: 50%; }
    .query-result { padding: 6px 8px; margin: 4px 0; background: #0d0d1a; border-radius: 4px; font-size: 11px; border-left: 2px solid #4a9fff; cursor: pointer; }
    .query-result:hover { border-left-color: #ff6b1a; background: #111122; }
    .query-result .result-type { font-size: 9px; text-transform: uppercase; color: #888; }
    .query-result .result-snippet { color: #aaa; margin-top: 2px; }
    .query-result .result-relevance { font-size: 10px; color: #4aff8a; float: right; }
    .kv-picker { max-height: 300px; overflow-y: auto; border: 1px solid #2a2a4a; border-radius: 6px; background: #0d0d1a; }
    .kv-picker-search { width: 100%; background: #0d0d1a; color: #e0e0e0; border: 1px solid #2a2a4a; border-radius: 4px; padding: 4px 8px; font-size: 11px; margin-bottom: 6px; }
    .kv-picker-search:focus { outline: none; border-color: #ff6b1a; }
    .kv-picker-group { border-top: 1px solid #1a1a2e; }
    .kv-picker-group-header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; font-size: 10px; font-weight: 600; color: #888; text-transform: uppercase; user-select: none; }
    .kv-picker-group-header:hover { background: #1a1a2e; }
    .kv-picker-group-header .arrow { transition: transform 0.15s; }
    .kv-picker-group-header.collapsed .arrow { transform: rotate(-90deg); }
    .kv-picker-group-items { display: none; }
    .kv-picker-group-header:not(.collapsed) + .kv-picker-group-items { display: block; }
    .kv-picker-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #1a1a2e; cursor: pointer; font-size: 11px; transition: background 0.1s; }
    .kv-picker-item:last-child { border-bottom: none; }
    .kv-picker-item:hover { background: #1a1a2e; }
    .kv-picker-item.selected { background: #1a2a4a; border-left: 2px solid #4a9fff; }
    .kv-picker-item input[type="checkbox"] { margin-top: 2px; accent-color: #ff6b1a; flex-shrink: 0; }
    .kv-picker-item .kv-ns { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 600; text-transform: uppercase; flex-shrink: 0; }
    .kv-ns-KV_NAMESPACES { background: #1a3a1a; color: #8aff4a; }
    .kv-ns-ORP_KV { background: #3a1a4a; color: #c14aff; }
    .kv-ns-AUDITS_KV { background: #4a1a2a; color: #ff4a6a; }
    .kv-ns-CONTEXT_KV { background: #1a2a4a; color: #4a9fff; }
    .kv-picker-item .kv-key { color: #aaa; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kv-picker-item .kv-preview { color: #666; font-size: 10px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .kv-picker-controls { display: flex; gap: 6px; padding: 6px 0; align-items: center; }
    .domain-stack-panel { display: flex; gap: 6px; align-items: center; padding: 4px 0; flex-wrap: wrap; }
    .domain-chip { padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer; border: 1px solid #2a2a4a; }
    .domain-chip.primary { border-color: #ff6b1a; background: #ff6b1a22; color: #ff6b1a; }
    .domain-chip.secondary { border-color: #2a2a4a; background: #22223a; color: #888; }
    .domain-chip:hover { border-color: #ff6b1a; }
    .domain-asset-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: #0d0d1a; border-radius: 4px; font-size: 11px; margin: 2px 0; }
    .domain-asset-item .asset-name { color: #4ab8ff; }
    .domain-asset-item .asset-size { color: #888; font-size: 10px; }
    .card-content { padding: 10px 12px; flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
    .card-content > textarea { width: 100%; background: var(--canvas); color: var(--text); border: 1px solid #2a2a4a; border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; resize: vertical; min-height: 100px; line-height: 1.6; tab-size: 2; flex: 1; }
    .card-content textarea:focus { outline: none; border-color: #ff6b1a; }
    .card-toolbar { display: flex; gap: 4px; padding: 4px 0; flex-wrap: wrap; align-items: center; }
    .card-toolbar .sep { width: 1px; height: 16px; background: #2a2a4a; margin: 0 2px; }
    .card-toolbar button { padding: 3px 8px; background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--muted); font-size: 11px; cursor: pointer; transition: all .12s; line-height: 1.4; }
    .card-toolbar button:hover { border-color: var(--border-strong); color: var(--text); background: var(--raised); }
    .card-toolbar button.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
    .card-toolbar button[title]::after { content: attr(title); }
    .browser-viewer { width: 100%; min-height: 200px; flex: 1; border: 1px solid #2a2a4a; border-radius: 6px; overflow: hidden; background: #fff; position: relative; }
    .browser-viewer iframe { width: 100%; height: 100%; position: absolute; top: 0; left: 0; border: none; }
    .browser-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: #1a1a2e; border-bottom: 1px solid #2a2a4a; font-size: 10px; }
    .browser-bar .url-display { flex: 1; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 4px; padding: 2px 6px; color: #4ab8ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .browser-bar button { padding: 2px 6px; background: #22223a; border: 1px solid #2a2a4a; border-radius: 3px; color: #888; font-size: 9px; cursor: pointer; }
    .browser-bar button:hover { color: #ff6b1a; border-color: #ff6b1a; }
    .md-preview { background: var(--canvas); color: #d5dae2; border: 1px solid #2a2a4a; border-radius: 6px; padding: 10px 12px; font-size: 13px; line-height: 1.7; min-height: 100px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word; }
    .md-preview h1 { font-size: 20px; font-weight: 700; margin: 8px 0 4px; color: #fff; }
    .md-preview h2 { font-size: 17px; font-weight: 600; margin: 8px 0 4px; color: #fff; }
    .md-preview h3 { font-size: 15px; font-weight: 600; margin: 6px 0 3px; color: #e0e0e0; }
    .md-preview p { margin: 4px 0; }
    .md-preview code { background: #22223a; padding: 1px 5px; border-radius: 3px; font-family: 'SF Mono', monospace; font-size: 12px; color: #ff8a4a; }
    .md-preview pre { background: #111122; border: 1px solid #2a2a4a; border-radius: 6px; padding: 10px; margin: 6px 0; overflow-x: auto; }
    .md-preview pre code { background: none; padding: 0; color: #e0e0e0; }
    .md-preview blockquote { border-left: 3px solid #ff6b1a; padding-left: 10px; margin: 6px 0; color: #aaa; }
    .md-preview ul, .md-preview ol { padding-left: 20px; margin: 4px 0; }
    .md-preview li { margin: 2px 0; }
    .md-preview a { color: #4ab8ff; text-decoration: none; }
    .md-preview a:hover { text-decoration: underline; }
    .md-preview hr { border: none; border-top: 1px solid #2a2a4a; margin: 8px 0; }
    .md-preview table { border-collapse: collapse; margin: 6px 0; width: 100%; }
    .md-preview th, .md-preview td { border: 1px solid #2a2a4a; padding: 4px 8px; text-align: left; font-size: 12px; }
    .md-preview th { background: #22223a; }
    .md-preview strong { color: #fff; }
    .md-preview em { color: #ccc; font-style: italic; }
    .card-url { font-size: 10px; color: #4ab8ff; word-break: break-all; margin-bottom: 4px; }
    .ctrl-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; background: var(--raised); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 12px; font-weight: 500; cursor: pointer; transition: all .12s; }
    .ctrl-btn:hover { background: var(--panel); border-color: var(--border-strong); }
    .action-btn { height: 32px; padding: 0 14px; background: var(--accent); color: #06121f; border: 1px solid var(--accent); border-radius: var(--radius); font-size: 12px; font-weight: 600; cursor: pointer; }
    .action-btn:hover { background: #6cb1ff; border-color: #6cb1ff; }
    .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .selected { border-color: #ff6b1a !important; box-shadow: 0 0 0 2px #ff6b1a55; }
    .rel-link { font-size: 10px; color: #ff6b1a99; }
    #canvas { position: relative; width: 100%; flex: 1 1 auto; min-height: 0; overflow: auto; }
        .topbar { min-height: 52px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 6px 10px; background: var(--panel); border-bottom: 1px solid var(--border); overflow: visible; flex: 0 0 auto; }
    .topbar-scroll { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; flex: 1 1 auto; min-width: 0; }
    .topbar-scroll::-webkit-scrollbar { height: 4px; }
    .topbar-scroll::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }
    .topbar-scroll::-webkit-scrollbar-track { background: transparent; }
    .topbar-group { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .topbar-sep { width: 1px; height: 22px; background: var(--border); flex-shrink: 0; }
    .topbar-right { margin-left: auto; gap: 10px; }
    .meta { font-family: var(--mono); font-size: 11px; color: var(--dim); white-space: nowrap; }
    .btn { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--ui); font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: background .12s, border-color .12s, color .12s; }
    .btn:hover { background: var(--raised); border-color: var(--border-strong); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .btn:disabled { opacity: .6; cursor: progress; }
    .btn .ico { font-family: var(--mono); font-size: 10px; letter-spacing: .4px; color: var(--muted); }
    .btn:hover .ico { color: var(--accent); }
    .btn.is-busy { position: relative; color: transparent; }
    .btn.is-busy .ico { visibility: hidden; }
    .btn.is-busy::after { content: ''; position: absolute; inset: 0; margin: auto; width: 12px; height: 12px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    @media (max-width: 1440px) { .btn .lbl { display: none; } }
    @media (max-width: 720px) { .topbar-right .meta { display: none; } }
    .logo { font-family: var(--mono); font-size: 13px; font-weight: 600; letter-spacing: 2px; white-space: nowrap; flex-shrink: 0; }
    .logo span { color: var(--accent); }
    .modal-overlay { position: fixed; inset: 0; background: rgba(4,6,10,0.72); display: flex; align-items: center; justify-content: center; z-index: var(--z-modal); }
    .modal { background: var(--panel); border: 1px solid var(--border-strong); border-radius: 8px; padding: 20px; width: 520px; max-width: 92vw; box-shadow: 0 18px 48px rgba(0,0,0,0.5); }
    .modal input, .modal textarea, .modal select { width: 100%; background: #0d0d1a; color: #e0e0e0; border: 1px solid #2a2a4a; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
    .modal input:focus, .modal textarea:focus { outline: none; border-color: #ff6b1a; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #2a2a4a; border-top-color: #ff6b1a; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .presence-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #4aff8a; margin-right: 4px; }
    .remote-cursor { position: absolute; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #ff6b1a; pointer-events: none; z-index: 50; transition: all 0.1s ease; }
    .ws-status { font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
    .ws-connected { background: #1a4a2a; color: #4aff8a; }
    .ws-disconnected { background: #4a1a1a; color: #ff4a4a; }
    .ws-connecting { background: #4a3a1a; color: #ffaa4a; }
    .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 200; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast { padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; pointer-events: auto; animation: toastIn 0.25s ease, toastOut 0.3s ease 2.7s forwards; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
    .toast-success { background: #1a4a2a; color: #4aff8a; border: 1px solid #2a6a3a; }
    .toast-info { background: #1a3a5a; color: #4ab8ff; border: 1px solid #2a5a7a; }
    .toast-error { background: #4a1a1a; color: #ff4a4a; border: 1px solid #6a2a2a; }
    .toast-processing { background: #4a3a1a; color: #ffaa4a; border: 1px solid #6a5a2a; }
    .toast-warning { background: #4a3a1a; color: #ffaa4a; border: 1px solid #6a5a2a; }
    @keyframes toastIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes toastOut { from { opacity: 1; } to { opacity: 0; transform: translateY(-10px); } }
    .drop-overlay { position: fixed; inset: 0; background: rgba(255,107,26,0.08); border: 3px dashed #ff6b1a; z-index: 150; display: flex; align-items: center; justify-content: center; pointer-events: none; }
    .drop-overlay-text { font-size: 22px; font-weight: 700; color: #ff6b1a; background: #1a1a2e; padding: 16px 32px; border-radius: 12px; border: 1px solid #ff6b1a55; }
    .file-upload-input { display: none; }
    .paste-hint { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 8px 16px; font-size: 11px; color: #888; z-index: 50; pointer-events: none; opacity: 0; transition: opacity 0.3s; }
    .paste-hint.visible { opacity: 1; }
    /* Docking zones */
    .dock-zone { position: absolute; background: rgba(255,107,26,0.15); border: 2px dashed #ff6b1a; border-radius: 4px; z-index: 5; pointer-events: none; opacity: 0; transition: opacity 0.15s; }
    .dock-zone.active { opacity: 1; }
    .dock-zone-left { left: -12px; top: 10%; width: 10px; height: 80%; }
    .dock-zone-right { right: -12px; top: 10%; width: 10px; height: 80%; }
    .dock-zone-top { top: -12px; left: 10%; width: 80%; height: 10px; }
    .dock-zone-bottom { bottom: -12px; left: 10%; width: 80%; height: 10px; }
    .card-window.docked { border-color: #ff6b1a; box-shadow: 0 0 0 2px #ff6b1a44, 0 8px 32px rgba(0,0,0,0.5); }
    .cluster-group { position: absolute; border: 1px solid #ff6b1a33; border-radius: 12px; background: rgba(255,107,26,0.03); pointer-events: none; }
    /* Resize handle */
    .resize-handle { position: absolute; bottom: 0; right: 0; width: 24px; height: 24px; cursor: nwse-resize; touch-action: none; z-index: 10; }
    .resize-handle::after { content: ''; position: absolute; bottom: 3px; right: 3px; width: 8px; height: 8px; border-right: 2px solid #4a4a6a; border-bottom: 2px solid #4a4a6a; }
    .resize-handle:hover::after { border-color: #ff6b1a; }
    /* SearchCard */
    .search-results { max-height: 250px; overflow-y: auto; margin-top: 6px; }
    .search-result-item { padding: 6px 8px; border: 1px solid #2a2a4a; border-radius: 4px; margin-bottom: 4px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
    .search-result-item:hover { border-color: #ff6b1a; background: #22223a; }
    .search-result-item .result-title { color: #4ab8ff; font-weight: 500; }
    .search-result-item .result-snippet { color: #888; font-size: 11px; margin-top: 2px; }
    /* Principle indicators */
    .principle-badge { display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 600; margin-left: 4px; }
    .principle-auto { background: #1a4a2a; color: #4aff8a; }
    .principle-expert { background: #4a3a1a; color: #ffaa4a; }
    .principle-conflict { background: #4a1a1a; color: #ff4a4a; }
    /* Dock edge indicators */
    .card-edge-dock { position: absolute; width: 4px; background: #ff6b1a; border-radius: 2px; z-index: 5; pointer-events: none; }
    .edge-dock-left { left: -2px; top: 10%; height: 80%; }
    .edge-dock-right { right: -2px; top: 10%; height: 80%; }
    .edge-dock-top { top: -2px; left: 10%; width: 80%; height: 4px; }
    .edge-dock-bottom { bottom: -2px; left: 10%; width: 80%; height: 4px; }
    .split-view { display: flex; gap: 0; flex: 1; min-height: 0; }
    .split-view .split-left, .split-view .split-right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .split-view .split-divider { width: 1px; background: #2a2a4a; cursor: col-resize; flex-shrink: 0; }
    .split-view .split-right { border-left: 1px solid #2a2a4a; overflow-y: auto; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">TRUTH<span>&middot;</span>ENGINE</div>
    <div class="topbar-scroll">
    <div class="topbar-group">
      <button class="btn" onclick="createCard('Browser')" title="Browser card"><span class="ico">BRW</span><span class="lbl">Browser</span></button>
      <button class="btn" onclick="createCard('Document')" title="Document card"><span class="ico">DOC</span><span class="lbl">Document</span></button>
      <button class="btn" onclick="createCard('Instruct')" title="Instruct card"><span class="ico">INS</span><span class="lbl">Instruct</span></button>
      <button class="btn" onclick="createCard('Import')" title="Import a file"><span class="ico">IMP</span><span class="lbl">Import</span></button>
      <button class="btn" onclick="createCard('Search')" title="Search the web"><span class="ico">SRCH</span><span class="lbl">Search</span></button>
    </div>
    <div class="topbar-sep"></div>
    <div class="topbar-group">
      <button class="btn" onclick="promptQuery()" title="Query the truth store"><span class="ico">QRY</span><span class="lbl">Query</span></button>
      <button class="btn" onclick="promptAudit()" title="Audit against principles"><span class="ico">AUD</span><span class="lbl">Audit</span></button>
      <button class="btn" onclick="withBusy(this, promptCompare)" title="Compare cods and mind on one ask"><span class="ico">CMP</span><span class="lbl">Compare</span></button>
      <button class="btn" onclick="withBusy(this, openWatchtower)" title="Watchtower: every tool's state"><span class="ico">WT</span><span class="lbl">Watchtower</span></button>
      <button class="btn" onclick="openTabList('eitl')" title="EITL review"><span class="ico">EITL</span><span class="lbl">EITL</span></button>
      <button class="btn" onclick="promptDomain()" title="Domain stack"><span class="ico">DOM</span><span class="lbl">Domain</span></button>
      <button class="btn" onclick="openNSM()" title="NSM layer"><span class="ico">NSM</span><span class="lbl">NSM</span></button>
    </div>
    </div>
    <div class="topbar-group topbar-right">
      <span id="wsStatus" class="ws-status ws-connecting">ws: connecting</span>
      <span id="presence" class="meta"></span>
      <span id="status" class="meta"></span>
      <button class="btn" onclick="openManipulate()" title="Merge or distill selected cards"><span class="ico">MRG</span><span class="lbl">Merge</span></button>
    </div>
  </div>
  <div id="canvas"></div>
  <div id="fetchModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">🌐 Browser Card — Fetch URL</h2>
      <p class="text-xs text-gray-400 mb-3">Enter a URL. The Worker fetches it, parses the content with HTMLRewriter, and creates a Browser card.</p>
      <input id="fetchUrl" type="url" placeholder="https://example.com/article" class="mb-4" />
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" onclick="closeFetch()">Cancel</button>
        <button id="fetchBtn" class="action-btn" onclick="runFetch()">Fetch</button>
      </div>
    </div>
  </div>
  <div id="searchModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">🔍 Search Card</h2>
      <p class="text-xs text-gray-400 mb-3">Type a query. Results render inside the card. Click a result to materialize it as a Browser or Document card.</p>
      <input id="searchQuery" type="text" placeholder="Search query..." class="mb-4" />
      <div id="searchResults" class="search-results" style="display:none;"></div>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" onclick="closeSearch()">Cancel</button>
        <button id="searchBtn" class="action-btn" onclick="runSearch()">Search</button>
      </div>
    </div>
  </div>
  <div id="principleModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">🔧 Principle Ratification</h2>
      <p class="text-xs text-gray-400 mb-3">The ambient LLM has proposed a new principle. Review and approve, edit, or kill it.</p>
      <div id="principlePreview" class="text-sm mb-3 p-3 bg-slate-950 border border-slate-800 rounded"></div>
      <div class="flex items-center gap-2 mb-3">
        <label class="text-xs text-gray-400">Domain:</label>
        <select id="principleDomain" class="flex-1">
          <option value="universal">Universal (auto-ratify)</option>
          <option value="ethical">Ethical (auto-ratify)</option>
          <option value="legal">Legal (axiom sleeve)</option>
          <option value="educational">Educational (axiom sleeve)</option>
        </select>
      </div>
      <label class="text-xs text-gray-400">Edit text (optional)</label>
      <textarea id="principleEditText" rows="2" class="mb-3"></textarea>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" style="border-color:#ff4a4a;color:#ff4a4a;" onclick="killPrinciple()">Kill</button>
        <button class="ctrl-btn" onclick="closePrinciple()">Cancel</button>
        <button class="action-btn" onclick="ratifyPrinciple('approve')">Ratify</button>
      </div>
    </div>
  </div>
  <div id="eitlReviewModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">📋 EITL Expert Review</h2>
      <p class="text-xs text-gray-400 mb-3">Review the output against the logged principles. Elevate, adjust, or remand.</p>
      <div id="eitlReviewContent" class="text-sm mb-3 p-3 bg-slate-950 border border-slate-800 rounded" style="max-height:200px;overflow-y:auto;white-space:pre-wrap;"></div>
      <label class="text-xs text-gray-400">Expert comment (optional)</label>
      <textarea id="eitlReviewComment" rows="2" class="mb-3" placeholder="Note for the gap log..."></textarea>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" style="border-color:#ff4a4a;color:#ff4a4a;" onclick="submitEitlReview('remand')">Remand</button>
        <button class="ctrl-btn" onclick="closeExpertReview()">Cancel</button>
        <button class="ctrl-btn" onclick="submitEitlReview('adjust')">Adjust</button>
        <button class="action-btn" onclick="submitEitlReview('elevate')">Elevate</button>
      </div>
    </div>
  </div>
  <div id="manipulateModal" class="modal-overlay" style="display:none;">
    <div class="modal">
      <h2 class="text-lg font-bold mb-4">Card Manipulation Engine</h2>
      <p class="text-xs text-gray-400 mb-3">Select cards on the canvas first, then choose an action.</p>
      <div id="selectedCount" class="text-sm mb-3"></div>
      <label class="text-xs text-gray-400">Action</label>
      <select id="actionSelect" class="w-full mb-3">
        <option value="merge">Merge — combine into one coherent doc</option>
        <option value="distill">Distill — extract essential truths</option>
        <option value="combine">Combine — unified synthesis</option>
        <option value="rewrite">Rewrite — transform per instruction</option>
      </select>
      <label class="text-xs text-gray-400">Instruction (optional)</label>
      <textarea id="manipulatePrompt" rows="3" class="mb-4" placeholder="e.g., Focus on technical accuracy and remove redundancy"></textarea>
      <div class="flex justify-end gap-2">
        <button class="ctrl-btn" onclick="closeManipulate()">Cancel</button>
        <button id="runBtn" class="action-btn" onclick="runManipulate()">Run</button>
      </div>
    </div>
  </div>
  <input id="fileUpload" class="file-upload-input" type="file" accept=".md,.markdown,.txt,.html,.htm,.docx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg" multiple />
  <div id="dropOverlay" class="drop-overlay" style="display:none;">
    <div class="drop-overlay-text">📄 Drop files to import</div>
  </div>
  <div id="toastContainer" class="toast-container"></div>
  <div id="pasteHint" class="paste-hint">Paste MD, HTML, DOCX, PDF, or images anywhere to create a card</div>
  <script>
    let cards = [];
    let selectedIds = new Set();
    let cardCounter = 0;
    let clusters = {}; // { clusterId: [cardId, ...] }
    let principles = []; // Principle engine store
    let wsParam = new URLSearchParams(location.search).get('ws') || 'default';
    const API = (path) => \`/api\${path}?ws=\${wsParam}\`;
    let ws = null;
    let wsReconnectTimer = null;
    let remoteCursors = {};
    let dockingActive = false;

    function connectWS() {
      setWsStatus('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${protocol}//\${location.host}/api/ws?ws=\${wsParam}\`);
      ws.onopen = () => { setWsStatus('connected'); if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; } };
      ws.onmessage = (event) => { handleMessage(JSON.parse(event.data)); };
      ws.onclose = () => { setWsStatus('disconnected'); wsReconnectTimer = setTimeout(connectWS, 3000); };
      ws.onerror = () => { setWsStatus('disconnected'); };
    }

    function setWsStatus(state) {
      const el = document.getElementById('wsStatus');
      el.className = \`ws-status ws-\${state}\`;
      el.textContent = state;
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case 'cards': cards = msg.cards; renderCards(); break;
        case 'principles': principles = msg.principles || []; renderPrincipleBadges(); break;
        case 'clusters': clusters = msg.clusters || {}; break;
        case 'card_created':
          if (!cards.find(c => c.id === msg.card.id)) {
            cards.push(msg.card); renderCard(msg.card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus();
          } break;
        case 'card_updated': { const idx = cards.findIndex(c => c.id === msg.card.id); if (idx !== -1) { cards[idx] = msg.card; updateCardDOM(msg.card); } break; }
        case 'card_deleted': cards = cards.filter(c => c.id !== msg.id); selectedIds.delete(msg.id); const el = document.getElementById(\`card-\${msg.id}\`); if (el) el.remove(); updateStatus(); break;
        case 'presence': document.getElementById('presence').innerHTML = msg.count > 0 ? \`<span class="presence-dot"></span>\${msg.count} live\` : ''; break;
        case 'cursor': updateRemoteCursor(msg.clientId, msg.x, msg.y); break;
        case 'principle_proposed': showPrincipleProposal(msg.principle); break;
      }
    }

    function sendWS(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

    function updateRemoteCursor(clientId, x, y) {
      if (!remoteCursors[clientId]) {
        const el = document.createElement('div'); el.className = 'remote-cursor'; document.getElementById('canvas').appendChild(el);
        remoteCursors[clientId] = { el, x, y };
      }
      const rc = remoteCursors[clientId];
      rc.el.style.left = \`\${x}px\`; rc.el.style.top = \`\${y}px\`;
      clearTimeout(rc.timeout); rc.timeout = setTimeout(() => { rc.el.remove(); delete remoteCursors[clientId]; }, 3000);
    }

    let cursorThrottle = null;
    document.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (cursorThrottle) return;
      cursorThrottle = setTimeout(() => {
        const canvas = document.getElementById('canvas'); if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        sendWS({ type: 'cursor', x: e.clientX - rect.left, y: e.clientY - rect.top, cardId: '' });
        cursorThrottle = null;
      }, 100);
    });

    async function init() {
      document.getElementById('status').textContent = 'Loading…';
      connectWS();
      await loadCards();
      await loadPrinciples();
      if (cards.length === 0) {
        await createCard('Instruct', 'Welcome', 'Truth Engine workspace initialized.\\n\\nFeatures:\\n• Browser cards — fetch & parse live web pages\\n• Document / Instruct / Import / Search cards\\n• Snap-based docking & fused card clusters\\n• Merge / Distill / Combine / Rewrite with AI\\n• Principle engine with EITL ratification\\n• Real-time multi-user sync via WebSocket\\n\\nShare this URL with ?ws=<name> to collaborate.');
      }
      autoNumberDocuments();
      setInterval(() => sendWS({ type: 'ping' }), 30000);
    }

    async function loadCards() { const res = await fetch(API('/cards')); cards = await res.json(); renderCards(); }

    async function createCard(type, title, content) {
      if (type && typeof type === 'object') {
        const cardObj = type;
        const extra = { ...cardObj }; const { id, ...fields } = extra; delete fields.type; delete fields.title; delete fields.content;
        const res = await fetch(API('/cards'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: cardObj.type, title: cardObj.title, content: cardObj.content || '', ...fields }) });
        const card = await res.json();
        if (!cards.find(c => c.id === card.id)) { cards.push(card); renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus(); }
        if ((cardObj.type === 'Import') && cardObj.content) { classifyImportContent(card.id, cardObj.content); }
        return card;
      }
      if (type === 'Browser' && !title) { openFetch(); return; }
      if (type === 'Search' && !title) { openSearch(); return; }
      if (type === 'Import' && !title) { document.getElementById('fileUpload').click(); return; }
      const res = await fetch(API('/cards'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, title: title || \`\${type} Card\`, content: content || '' }) });
      const card = await res.json();
      if (!cards.find(c => c.id === card.id)) { cards.push(card); renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus(); }
      if (type === 'Import' && content) { classifyImportContent(card.id, content); }
      return card;
    }

    async function updateCard(id, patch) { await fetch(API(\`/cards/\${id}\`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); }
    async function deleteCard(id) { await fetch(API(\`/cards/\${id}\`), { method: 'DELETE' }); }

    function openFetch() { document.getElementById('fetchModal').style.display = 'flex'; document.getElementById('fetchUrl').focus(); }
    function closeFetch() { document.getElementById('fetchModal').style.display = 'none'; }

    async function runFetch() {
      const url = document.getElementById('fetchUrl').value.trim(); if (!url) return;
      const btn = document.getElementById('fetchBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Fetching…';
      try {
        const res = await fetch(API('/fetch'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
        const card = await res.json();
        if (res.ok) { closeFetch(); document.getElementById('fetchUrl').value = ''; } else { alert('Error: ' + (card.error || 'Unknown')); }
      } catch (err) { alert('Fetch failed: ' + err.message); }
      finally { btn.disabled = false; btn.textContent = 'Fetch'; }
    }

    document.addEventListener('DOMContentLoaded', () => { document.getElementById('fetchUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') runFetch(); }); });

    function renderCards() {
      const canvas = document.getElementById('canvas');
      const positions = {};
      document.querySelectorAll('.card-window').forEach(el => { positions[el.dataset.id] = { left: el.style.left, top: el.style.top }; });
      canvas.innerHTML = ''; cardCounter = 0;
      cards.forEach((card) => {
        // Saved coordinates are the truth; the cascade is only for a card that has never
        // been placed. Left of 0 is a real position, which is why it must not be treated
        // as missing - that turned every tile snapped to the left edge into a fan-out.
        const pos = positions[card.id];
        const cascade = cardCounter * 30 + 40;
        const hasDom = !!(pos && pos.left !== '' && pos.top !== '');
        const hasModel = typeof card.x === 'number' && typeof card.y === 'number';
        const x = hasDom ? parseFloat(pos.left) : (hasModel ? card.x : cascade);
        const y = hasDom ? parseFloat(pos.top) : (hasModel ? card.y : cascade);
        renderCard(card, Number.isFinite(x) ? x : cascade, Number.isFinite(y) ? y : cascade);
        cardCounter++;
      });
      updateStatus();
    }

    function renderCard(card, x, y) {
      const canvas = document.getElementById('canvas');
      const el = document.createElement('div');
      el.id = \`card-\${card.id}\`;
      el.style.left = \`\${x}px\`; el.style.top = \`\${y}px\`; el.dataset.id = card.id;
      el.dataset.rawHtml = card.rawHtml ? '1' : '0';
      const badgeClass = \`badge-\${card.type.toLowerCase()}\`;
      const isBrowser = card.type === 'Browser';
      const isSearch = card.type === 'Search';
      const isImport = card.type === 'Import';
      el.className = \`card-window\${isBrowser ? ' browser-card' : ''}\`;
      if (card.width) el.style.width = \`\${card.width}px\`;
      if (card.height) {
        // An explicit height is what keeps a resized tile from being pushed back open by
        // its content on the next render - minHeight alone was not enough.
        el.style.minHeight = \`\${card.height}px\`;
        el.style.height = \`\${card.height}px\`;
      }

      // Docking zones
      el.innerHTML = \`
        <div class="dock-zone dock-zone-left" data-dock="left"></div>
        <div class="dock-zone dock-zone-right" data-dock="right"></div>
        <div class="dock-zone dock-zone-top" data-dock="top"></div>
        <div class="dock-zone dock-zone-bottom" data-dock="bottom"></div>
      \`;

      const fmtBar = \`
        <div class="card-toolbar fmt-bar" data-fmtbar="\${card.id}">
          <button onclick="fmtBold('\${card.id}')" title="B"><b>B</b></button>
          <button onclick="fmtItalic('\${card.id}')" title="I"><i>I</i></button>
          <button onclick="fmtStrike('\${card.id}')" title="S"><s>S</s></button>
          <span class="sep"></span>
          <button onclick="fmtHeading('\${card.id}',1)" title="H1">H1</button>
          <button onclick="fmtHeading('\${card.id}',2)" title="H2">H2</button>
          <button onclick="fmtHeading('\${card.id}',3)" title="H3">H3</button>
          <span class="sep"></span>
          <button onclick="fmtList('\${card.id}')" title="UL">• List</button>
          <button onclick="fmtOList('\${card.id}')" title="OL">1. List</button>
          <button onclick="fmtQuote('\${card.id}')" title="Quote">&gt;</button>
          <span class="sep"></span>
          <button onclick="fmtCode('\${card.id}')" title="Code">&lt;/&gt;</button>
          <button onclick="fmtCodeBlock('\${card.id}')" title="Block">{ }</button>
          <span class="sep"></span>
          <button onclick="fmtLink('\${card.id}')" title="Link">🔗</button>
          <button onclick="fmtImage('\${card.id}')" title="Image">🖼</button>
          <button onclick="fmtHr('\${card.id}')" title="HR">―</button>
        </div>
      \`;

      let contentHtml;
      if (isSearch) {
        contentHtml = \`
          <div style="padding:4px 0;">
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <input type="text" data-search-input="\${card.id}" placeholder="Search query..." style="flex:1;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:4px 8px;font-size:12px;" />
              <button onclick="runCardSearch('\${card.id}')" style="padding:4px 10px;background:#ff6b1a;color:#0d0d1a;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Go</button>
            </div>
            <div class="search-results" data-search-results="\${card.id}"></div>
          </div>
        \`;
      } else if (isImport) {
        contentHtml = \`
          <div class="border-2 border-dashed border-slate-700 p-6 text-center">
            <div class="text-sm text-slate-400 mb-2">Drop files here or paste content</div>
            <div class="text-xs text-slate-500">Classifies incoming content and proposes principle activations</div>
            <button onclick="document.getElementById('fileUpload').click()" style="margin-top:8px;padding:4px 12px;background:#2a2a4a;border:1px solid #4a4a6a;border-radius:4px;color:#e0e0e0;font-size:11px;cursor:pointer;">Browse Files</button>
          </div>
          <div data-import-classification="\${card.id}" style="margin-top:8px;"></div>
        \`;
      } else if (card.type === 'Instruct') {
        const activePrinciples = principles.filter(p => {
          if (p.domainTag === 'universal' || p.domainTag === 'ethical') return true;
          return card.domains && card.domains.includes(p.domainTag);
        });
        const principleContext = activePrinciples.map(p => '• [' + p.domainTag + '] ' + p.text).join('\\n');
        contentHtml = \`
          <div style="padding:4px 0;">
            <div class="card-toolbar" style="margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
            </div>
            \${fmtBar}
            <textarea data-content="\${card.id}" placeholder="Enter instruction...\\n\\nThe ambient LLM will route this through the active principle stack. Output is domain-bound before it exists.">\${escapeHtml(card.content || '')}</textarea>
            <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
            <div style="margin-bottom:6px;padding:6px 8px;background:#111122;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;color:#888;">
              <span style="color:#ff8a4a;font-weight:600;">Principle Stack Active:</span> \${activePrinciples.length} principles bound
            </div>
            <textarea data-content="\${card.id}" placeholder="Enter instruction...\\n\\nThe ambient LLM will route this through the active principle stack. Output is domain-bound before it exists." style="width:100%;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:6px;padding:8px 10px;font-size:13px;font-family:'SF Mono','Fira Code',monospace;resize:vertical;min-height:80px;line-height:1.6;tab-size:2;"></textarea>
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button onclick="runInstruct('\${card.id}')" class="action-btn" style="flex:1;">Generate</button>
              <button onclick="checkPrincipleCompliance('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Check Compliance</button>
            </div>
            <div data-instruct-output="\${card.id}" style="margin-top:8px;"></div>
          </div>
        \`;
      } else if (card.type === 'Document' && card.splitView) {
        contentHtml = \`
          <div class="split-view" data-splitview="\${card.id}">
            <div class="split-left" style="padding-right:4px;">
              <div class="card-toolbar" style="margin-bottom:0;">
                <button class="active" data-mode="split" onclick="toggleCardMode('\${card.id}','split')">Split</button>
                <button data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
                <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
              </div>
              \${fmtBar}
              <textarea data-content="\${card.id}" placeholder="Drafting surface...—left pane: write. Right pane: live render." style="width:100%;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:6px;padding:8px 10px;font-size:13px;font-family:'SF Mono','Fira Code',monospace;min-height:200px;line-height:1.6;tab-size:2;resize:vertical;"></textarea>
            </div>
            <div class="split-divider"></div>
            <div class="split-right md-preview" data-preview="\${card.id}" style="padding:10px 12px;min-height:200px;"></div>
          </div>
        \`;
      } else if (isBrowser) {
        const proxyUrl = card.url ? \`/api/proxy?url=\${encodeURIComponent(card.url)}\` : '';
        contentHtml = \`
          <div class="browser-bar" style="margin-bottom:6px;">
            <input type="text" class="url-input" data-url-input="\${card.id}" value="\${escapeHtml(card.url || '')}" placeholder="mind  or  mind.ai-n.workers.dev" style="flex:1;background:#0d0d1a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;padding:3px 8px;font-size:11px;font-family:monospace;" />
            <button onclick="browserNavigate('\${card.id}')" style="padding:3px 8px;background:#ff6b1a;color:#0d0d1a;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Go</button>
            <button onclick="openBrowserFullscreen('\${card.id}')" title="Open full screen" style="padding:3px 8px;background:#22223a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;font-size:10px;cursor:pointer;">⛶</button>
          </div>
          \${proxyUrl ? \`<div class="browser-viewer"><iframe data-browser-frame="\${card.id}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" src="\${proxyUrl}" style="width:100%;height:100%;border:none;"></iframe></div>\` : \`<div style="padding:20px;text-align:center;color:#666;font-size:12px;">Enter a URL above and press Go</div>\`}
          <details style="margin-top:6px;">
            <summary style="cursor:pointer;color:#888;font-size:11px;">Extracted content</summary>
            <div class="card-toolbar" style="margin-top:4px;margin-bottom:0;">
              <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
              <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
            </div>
            \${fmtBar}
            <textarea data-content="\${card.id}" style="display:none;" placeholder="Extracted content…">\${escapeHtml(card.content)}</textarea>
            <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
          </details>
        \`;
      } else if (card.type === 'Query') {
        if (card._pickerHtml) {
          contentHtml = card._pickerHtml;
        } else {
          const results = card.results || [];
          const domainLabel = card.domainStack?.primary || card.domains?.[0] || 'general';
          contentHtml = \`
            <div style="padding:4px 0;">
              <div class="card-toolbar" style="margin-bottom:0;">
                <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
                <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
              </div>
              \${fmtBar}
              <textarea data-content="\${card.id}" placeholder="Query notes…">\${escapeHtml(card.content || '')}</textarea>
              <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="font-size:10px;color:#888;">Domain:</span>
                <span class="domain-chip primary" style="font-size:9px;">\${domainLabel}</span>
                <span style="font-size:10px;color:#888;margin-left:auto;">Coverage:</span>
                <span style="font-size:11px;color:#4aff8a;font-weight:600;">\${Math.round((card.coverageScore || 0) * 100)}%</span>
              </div>
              \${card.kvSelectedEntries && card.kvSelectedEntries.length ? '<div style="font-size:10px;color:#888;margin-bottom:4px;">' + card.kvSelectedEntries.length + ' KV entry(ies) selected</div>' : ''}
              <div style="font-size:10px;color:#888;margin-bottom:4px;">\${results.length} result(s) · \${(card.principlesApplied || []).length} principles applied</div>
              <div class="query-results" data-query-results="\${card.id}">
                \${results.map((r, i) => \`
                  <div class="query-result" onclick="materializeQueryResult('\${card.id}', \${i})">
                    <div style="display:flex;justify-content:space-between;">
                      <span class="result-type">\${r.sourceType}</span>
                      <span class="result-relevance">\${Math.round((r.relevance || 0) * 100)}%</span>
                    </div>
                    <div class="result-snippet">\${escapeHtml((r.snippet || '').slice(0, 120))}\${(r.snippet || '').length > 120 ? '...' : ''}</div>
                  </div>
                \`).join('')}
              </div>
              <div style="margin-top:6px;display:flex;gap:6px;">
                <button onclick="rerunQuery('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Re-run</button>
              </div>
            </div>
          \`;
        }
      } else if (card.type === 'Audit') {
        if (card._pickerHtml) {
          contentHtml = card._pickerHtml;
        } else {
          const findings = card.findings || [];
          const cov = card.principleCoverage || { total: 0, satisfied: 0, violated: 0, unaddressed: 0 };
          const statusColor = card.status === 'pass' ? '#4aff8a' : card.status === 'conditional' ? '#ffaa4a' : '#ff4a4a';
          contentHtml = \`
            <div style="padding:4px 0;" class="audit-\${card.status || 'fail'}">
              <div class="card-toolbar" style="margin-bottom:0;">
                <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
                <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
              </div>
              \${fmtBar}
              <textarea data-content="\${card.id}" placeholder="Audit notes…">\${escapeHtml(card.content || '')}</textarea>
              <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
              \${card.kvSelectedEntries && card.kvSelectedEntries.length ? '<div style="font-size:10px;color:#888;margin-bottom:4px;">' + card.kvSelectedEntries.length + ' KV entry(ies) audited</div>' : ''}
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="font-size:12px;font-weight:700;color:\${statusColor};text-transform:uppercase;">\${card.status || 'fail'}</span>
                <span style="font-size:11px;color:#888;">Confidence:</span>
                <span style="font-size:11px;color:\${statusColor};font-weight:600;">\${Math.round((card.overallConfidence || 0) * 100)}%</span>
                <span style="font-size:10px;color:#888;margin-left:auto;">Scope: \${card.auditScope || 'compliance'}</span>
              </div>
              <div class="audit-coverage">
                <div class="cov-item"><div class="cov-dot" style="background:#4aff8a;"></div> \${cov.satisfied} satisfied</div>
                <div class="cov-item"><div class="cov-dot" style="background:#ffaa4a;"></div> \${cov.violated} partial</div>
                <div class="cov-item"><div class="cov-dot" style="background:#ff4a4a;"></div> \${cov.unaddressed} unaddressed</div>
              </div>
              <div style="font-size:10px;color:#888;margin:4px 0;">\${findings.length} finding(s)</div>
              <div class="audit-findings" data-audit-findings="\${card.id}" style="max-height:200px;overflow-y:auto;">
                \${findings.slice(0, 20).map(f => \`
                  <div class="audit-finding \${f.severity}">
                    <div style="display:flex;justify-content:space-between;">
                      <span style="font-weight:600;color:\${f.severity === 'violation' ? '#ff4a4a' : f.severity === 'warning' ? '#ffaa4a' : '#4a9fff'};">\${f.severity.toUpperCase()}</span>
                      <span style="color:#888;font-size:10px;">\${Math.round((f.confidence || 0) * 100)}%</span>
                    </div>
                    <div style="color:#ccc;margin:2px 0;">\${escapeHtml(f.description)}</div>
                    \${f.suggestion ? \`<div style="color:#888;font-size:10px;">Suggestion: \${escapeHtml(f.suggestion)}</div>\` : ''}
                  </div>
                \`).join('')}
                \${findings.length > 20 ? \`<div style="text-align:center;color:#888;font-size:10px;padding:4px;">+\${findings.length - 20} more findings</div>\` : ''}
              </div>
              <div style="margin-top:6px;display:flex;gap:6px;">
                <button onclick="reAudit('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Re-audit</button>
                <button onclick="exportAudit('\${card.id}')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;">Export</button>
              </div>
            </div>
          \`;
        }
      } else if (card.type === 'DomainBrowser') {
        const assets = card.assets || [];
        const dMeta = { general: {color:'#888'}, legal: {color:'#4ab8ff'}, educational: {color:'#8aff4a'}, medical: {color:'#ff4a8a'}, technical: {color:'#c14aff'} };
        const dColor = dMeta[card.domain]?.color || '#888';
        contentHtml = \`
          <div style="padding:4px 0;">
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <button onclick="switchDomainView('\${card.id}','assets')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\${card.view === 'assets' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Assets</button>
              <button onclick="switchDomainView('\${card.id}','principles')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\${card.view === 'principles' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Principles</button>
              <button onclick="switchDomainView('\${card.id}','stack')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;\${card.view === 'stack' ? 'border-color:#ff6b1a;color:#ff6b1a;' : ''}">Stack</button>
            </div>
            <div data-domain-view="\${card.id}">
              \${card.view === 'assets' ? \`
                <div style="font-size:10px;color:#888;margin-bottom:4px;">\${assets.length} asset(s) in \${card.domain}</div>
                \${assets.map(a => \`
                  <div class="domain-asset-item">
                    <span class="asset-name">\${a.key.split('/').pop()}</span>
                    <span class="asset-size">\${a.size ? Math.round(a.size / 1024) + 'KB' : ''}</span>
                  </div>
                \`).join('')}
                \${assets.length === 0 ? '<div style="color:#666;font-size:11px;text-align:center;padding:8px;">No assets</div>' : ''}
              \` : card.view === 'principles' ? \`
                <div style="font-size:10px;color:#888;margin-bottom:4px;">\${card.principleCount || 0} principle(s) for \${card.domain}</div>
                <button onclick="syncDomainPrinciples('\${card.domain}')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;margin-bottom:6px;">Sync to KV</button>
              \` : \`
                <div style="font-size:11px;color:#ccc;">
                  <div>Primary: <span class="domain-chip primary">\${card.activeStack?.primary || card.domain}</span></div>
                  \${card.activeStack?.secondary?.length ? \`<div style="margin-top:4px;">Secondary: \${card.activeStack.secondary.map(s => \`<span class="domain-chip secondary">\${s}</span>\`).join(' ')}</div>\` : ''}
                </div>
              \`}
            </div>
            <div style="margin-top:6px;">
              <button onclick="uploadToDomain('\${card.id}', '\${card.domain}')" class="ctrl-btn" style="font-size:10px;padding:3px 8px;width:100%;">Upload Asset</button>
            </div>
          </div>
        \`;
      } else if (card.rawHtml) {
        contentHtml = \`
          <div class="card-toolbar" style="margin-bottom:0;">
            <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
            <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
          </div>
          \${fmtBar}
          <div data-rawcontent="\${card.id}" style="padding:8px;">\${card.content}</div>
          <textarea data-content="\${card.id}" style="display:none;">\${escapeHtml(card.content)}</textarea>
          <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
        \`;
      } else {
        contentHtml = \`
          <div class="card-toolbar" style="margin-bottom:0;">
            <button class="active" data-mode="edit" onclick="toggleCardMode('\${card.id}','edit')">Edit</button>
            <button data-mode="preview" onclick="toggleCardMode('\${card.id}','preview')">Preview</button>
          </div>
          \${fmtBar}
          <textarea data-content="\${card.id}" placeholder="Enter content…">\${escapeHtml(card.content)}</textarea>
          <div class="md-preview" data-preview="\${card.id}" style="display:none;"></div>
        \`;
      }

      // Principle badges for active card
      const principleHtml = getCardPrincipleBadges(card);
      const domainSelector = (card.type === 'Document' || card.type === 'Instruct') ? \`
        <select data-domain-select="\${card.id}" style="font-size:9px;padding:1px 4px;background:#0d0d1a;color:#888;border:1px solid #2a2a4a;border-radius:3px;cursor:pointer;" onchange="setDomain('\${card.id}', this.value)">
          <option value="general" \${(!card.domains || card.domains[0] === 'general') ? 'selected' : ''}>General</option>
          <option value="legal" \${card.domains && card.domains[0] === 'legal' ? 'selected' : ''}>Legal</option>
          <option value="educational" \${card.domains && card.domains[0] === 'educational' ? 'selected' : ''}>Edu</option>
          <option value="medical" \${card.domains && card.domains[0] === 'medical' ? 'selected' : ''}>Med</option>
          <option value="technical" \${card.domains && card.domains[0] === 'technical' ? 'selected' : ''}>Tech</option>
        </select>
      \` : '';
      const eitlBtn = (card.type === 'Document' || card.type === 'Instruct') ? \`<button onclick="openExpertReview('\${card.id}')" style="font-size:9px;padding:1px 4px;background:#4a3a1a;border:1px solid #6a5a2a;border-radius:3px;color:#ffaa4a;cursor:pointer;">EITL</button>\` : '';

      el.innerHTML += \`
        <div class="card-header">
          <div class="flex items-center gap-2 flex-1">
            <span class="card-type-badge \${badgeClass}">\${card.type}</span>
            <input class="card-title bg-transparent text-sm font-semibold text-white outline-none w-full" value="\${escapeHtml(cardTitleText(card))}" placeholder="\${escapeHtml(cardTitleHint(card))}" data-title="\${card.id}" />
            \${domainSelector}
            \${eitlBtn}
            \${principleHtml}
          </div>
          <button class="text-gray-500 hover:text-blue-400 text-sm ml-1" title="Fullscreen" onclick="openCardFullscreen('\${card.id}')">⛶</button>
          <button class="text-gray-500 hover:text-red-400 text-sm ml-2" onclick="deleteCard('\${card.id}')">✕</button>
        </div>
        <div class="card-content">
          \${contentHtml}
          \${card.relationships.length ? \`<div class="mt-2 rel-link">↳ derived from: \${card.relationships.length} card(s)</div>\` : ''}
        </div>
        <div class="resize-handle" data-resize="\${card.id}"></div>
      \`;
      canvas.appendChild(el);
      if (isBrowser) fitBrowserFrames(el);

      // Attach event listeners
      el.addEventListener('click', (e) => { if (['TEXTAREA','INPUT','BUTTON','A','IFRAME','DETAILS','SUMMARY','SELECT'].includes(e.target.tagName)) return; toggleSelect(card.id); });
      const titleInput = el.querySelector(\`[data-title="\${card.id}"]\`);
      titleInput.addEventListener('change', () => updateCard(card.id, { title: titleInput.value }));

      // Search card enter key
      if (isSearch) {
        const searchInput = el.querySelector(\`[data-search-input="\${card.id}"]\`);
        if (searchInput) {
          searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCardSearch(card.id); });
        }
      }

      // Browser URL bar enter key
      if (isBrowser) {
        const urlInput = el.querySelector(\`[data-url-input="\${card.id}"]\`);
        if (urlInput) {
          urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') browserNavigate(card.id); });
        }
      }

      const contentArea = el.querySelector(\`[data-content="\${card.id}"]\`);
      if (contentArea) {
        let debounce;
        contentArea.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => updateCard(card.id, { content: contentArea.value }), 600);
          // Live split view rendering
          const preview = el.querySelector(\`[data-preview="\${card.id}"]\`);
          if (preview && card.splitView) { preview.innerHTML = renderMarkdown(contentArea.value); }
          // Live instruct principle check
          if (card.type === 'Instruct') { /* content typed, no auto-action */ }
        });
        contentArea.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = contentArea.selectionStart;
            const end = contentArea.selectionEnd;
            contentArea.value = contentArea.value.substring(0, start) + '  ' + contentArea.value.substring(end);
            contentArea.selectionStart = contentArea.selectionEnd = start + 2;
          }
        });
      }

      // Phase 3: Setup split view for Document cards
      if (card.splitView && card.type === 'Document') {
        setupSplitViewLiveRendering(card.id);
      }

      makeDraggable(el);
      makeResizable(el, card.id);
    }

    function updateCardDOM(card) {
      const el = document.getElementById(\`card-\${card.id}\`);
      if (!el) { renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; return; }
      const titleInput = el.querySelector(\`[data-title="\${card.id}"]\`);
      const contentArea = el.querySelector(\`[data-content="\${card.id}"]\`);
      const preview = el.querySelector(\`[data-preview="\${card.id}"]\`);
      if (titleInput && document.activeElement !== titleInput) titleInput.value = card.title;
      if (contentArea && document.activeElement !== contentArea) {
        contentArea.value = card.content || '';
        if (preview && preview.style.display !== 'none') {
          preview.innerHTML = renderMarkdown(card.content || '');
        }
      }
    }

    function toggleSelect(id) { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); document.getElementById(\`card-\${id}\`).classList.toggle('selected', selectedIds.has(id)); }
    function updateStatus() { document.getElementById('status').textContent = \`\${cards.length} cards · \${selectedIds.size} selected\`; }

    let dragState = null; // { type: 'drag', el, dx, dy } | { type: 'resize', el, cardId, sx, sy, sw, sh }

    // Cards dropped by hand sit a few pixels off the edge they look aligned to.
    // Snapping measures the rendered box, so it works whatever the canvas offset is.
    const SNAP_PX = 10;
    // Small enough for a half-dozen tiles on one screen. The 280x200 floor is what made
    // six squares impossible before.
    const MIN_W = 160;
    const MIN_H = 110;
    function snapGuidesLayer() {
      let layer = document.getElementById('snapGuides');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'snapGuides';
        layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:var(--z-panel);display:none';
        document.body.appendChild(layer);
      }
      return layer;
    }
    function drawSnapGuides(guides) {
      const layer = snapGuidesLayer();
      layer.innerHTML = '';
      if (!guides.length) { layer.style.display = 'none'; return; }
      layer.style.display = 'block';
      guides.forEach(function (g) {
        const line = document.createElement('div');
        line.style.cssText = 'position:absolute;background:var(--accent);opacity:.6;' +
          (g.axis === 'x' ? 'left:' + Math.round(g.pos) + 'px;top:0;bottom:0;width:1px' : 'top:' + Math.round(g.pos) + 'px;left:0;right:0;height:1px');
        layer.appendChild(line);
      });
    }
    function clearSnapGuides() {
      const layer = document.getElementById('snapGuides');
      if (!layer) return;
      layer.innerHTML = '';
      layer.style.display = 'none';
    }
    function canvasOrigin() {
      const canvas = document.getElementById('canvas');
      if (!canvas) return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
      const r = canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    function boundaries(el, origin) {
      // Every edge a card can butt against, in canvas coordinates, gathered in one pass
      // so a gesture never mixes viewport and canvas space.
      const xs = [0, origin.w];
      const ys = [0, origin.h];
      const all = document.querySelectorAll('.card-window');
      for (let i = 0; i < all.length; i++) {
        const other = all[i];
        if (other === el) continue;
        const r = other.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        xs.push(Math.round(r.left - origin.x), Math.round(r.right - origin.x));
        ys.push(Math.round(r.top - origin.y), Math.round(r.bottom - origin.y));
      }
      return { xs: xs, ys: ys };
    }
    function nearestEdge(value, list) {
      let best = null;
      for (let i = 0; i < list.length; i++) {
        const d = Math.abs(value - list[i]);
        if (d <= SNAP_PX && (best === null || d < best.d)) best = { at: list[i], d: d };
      }
      return best;
    }
    function snapDrag(el, left, top) {
      // Pure: it takes the position the pointer asks for and returns the position to
      // render. It never reads the element's own style, so a snap cannot feed into the
      // next move - that feedback loop is what made dragging shudder.
      const origin = canvasOrigin();
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const lines = boundaries(el, origin);
      const guides = [];
      let sLeft = left;
      let sTop = top;
      let pinLeft = false;
      let pinTop = false;

      const edgeL = nearestEdge(left, lines.xs);
      const edgeR = nearestEdge(left + w, lines.xs);
      if (edgeL && (!edgeR || edgeL.d <= edgeR.d)) {
        sLeft = edgeL.at; pinLeft = edgeL.at === 0;
        guides.push({ axis: 'x', pos: origin.x + edgeL.at });
      } else if (edgeR) {
        sLeft = edgeR.at - w;
        guides.push({ axis: 'x', pos: origin.x + edgeR.at });
      }

      const edgeT = nearestEdge(top, lines.ys);
      const edgeB = nearestEdge(top + h, lines.ys);
      if (edgeT && (!edgeB || edgeT.d <= edgeB.d)) {
        sTop = edgeT.at; pinTop = edgeT.at === 0;
        guides.push({ axis: 'y', pos: origin.y + edgeT.at });
      } else if (edgeB) {
        sTop = edgeB.at - h;
        guides.push({ axis: 'y', pos: origin.y + edgeB.at });
      }

      // Pinned to the left edge means top-left: unless something is already holding the
      // top, the card goes home to the corner rather than hovering halfway down.
      if (pinLeft && !pinTop && !nearestEdge(sTop, lines.ys)) {
        sTop = 0;
        guides.push({ axis: 'y', pos: origin.y });
      }
      return { left: sLeft, top: sTop, guides: guides };
    }
    function lockBackground(on, el) {
      // While a card moves, the page behind it stops reacting: no hover states on other
      // cards, no text selection, no touch scroll stealing the gesture. This is the lock
      // that keeps the canvas still under the cursor.
      document.body.style.userSelect = on ? 'none' : '';
      document.body.style.touchAction = on ? 'none' : '';
      const all = document.querySelectorAll('.card-window');
      for (let i = 0; i < all.length; i++) {
        if (on && el && all[i] !== el) all[i].style.pointerEvents = 'none';
        else all[i].style.pointerEvents = '';
      }
    }
    function makeDraggable(el) {
      const header = el.querySelector('.card-header');
      if (!header) return;
      function begin(clientX, clientY) {
        const rect = el.getBoundingClientRect();
        // Grab offset stays in viewport space, the canvas origin is captured once: if the
        // canvas shifts mid-gesture the card does not jump by the offset.
        dragState = { type: 'drag', el: el, grabX: clientX - rect.left, grabY: clientY - rect.top, origin: canvasOrigin() };
        lockBackground(true, el);
        showDockZones(el.dataset.id);
      }
      function move(clientX, clientY) {
        if (!dragState || dragState.type !== 'drag' || dragState.el !== el) return;
        const rawLeft = clientX - dragState.grabX - dragState.origin.x;
        const rawTop = clientY - dragState.grabY - dragState.origin.y;
        const snapped = snapDrag(el, rawLeft, rawTop);
        el.style.left = snapped.left + 'px';
        el.style.top = snapped.top + 'px';
        drawSnapGuides(snapped.guides);
        highlightNearestDock(el.dataset.id, clientX, clientY);
      }
      function end(clientX, clientY) {
        if (!dragState || dragState.type !== 'drag' || dragState.el !== el) return;
        hideDockZones();
        clearSnapGuides();
        lockBackground(false, el);
        tryDock(el.dataset.id, clientX, clientY);
        dragState = null;
      }
      header.addEventListener('touchstart', function (e) {
        const t = e.touches[0];
        if (!t) return;
        if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].indexOf(e.target.tagName) !== -1) return;
        begin(t.clientX, t.clientY);
      }, { passive: false });
      header.addEventListener('touchmove', function (e) {
        const t = e.touches[0];
        if (!t) return;
        move(t.clientX, t.clientY);
        e.preventDefault();
      }, { passive: false });
      header.addEventListener('touchend', function (e) {
        const t = e.changedTouches[0];
        const rect = el.getBoundingClientRect();
        end(t ? t.clientX : rect.left, t ? t.clientY : rect.top);
      });
      header.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].indexOf(e.target.tagName) !== -1) return;
        e.preventDefault();
        begin(e.clientX, e.clientY);
      });
      header.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); });
      header.addEventListener('mouseup', function (e) { end(e.clientX, e.clientY); });
    }

    function makeResizable(el, cardId) {
      const handle = el.querySelector(\`[data-resize="\${cardId}"]\`);
      if (!handle) return;
      handle.addEventListener('touchstart', (e) => {
        const t = e.touches[0]; if (!t) return;
        const rect = el.getBoundingClientRect();
        dragState = { type: 'resize', el, cardId, sx: t.clientX, sy: t.clientY, sw: rect.width, sh: rect.height };
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
      handle.addEventListener('touchmove', (e) => {
        if (!dragState || dragState.type !== 'resize' || dragState.cardId !== cardId) return;
        const t = e.touches[0];
        applyResize(t.clientX, t.clientY);
        e.preventDefault();
      }, { passive: false });
      handle.addEventListener('touchend', () => { finishResize(cardId); });
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const rect = el.getBoundingClientRect();
        dragState = { type: 'resize', el, cardId, sx: e.clientX, sy: e.clientY, sw: rect.width, sh: rect.height };
        e.preventDefault();
        e.stopPropagation();
      });
      handle.addEventListener('mousemove', (e) => { if (dragState && dragState.type === 'resize' && dragState.cardId === cardId) applyResize(e.clientX, e.clientY); });
      handle.addEventListener('mouseup', (e) => { if (e.button === 0) finishResize(cardId); });
    }

    function applyResize(cx, cy) {
      if (!dragState || dragState.type !== 'resize') return;
      const origin = canvasOrigin();
      let w = Math.max(MIN_W, dragState.sw + (cx - dragState.sx));
      let h = Math.max(MIN_H, dragState.sh + (cy - dragState.sy));
      // The same edges that catch a moving card catch a stretching one, so a resized
      // window can be butted exactly against its neighbour instead of by eye.
      const lines = boundaries(dragState.el, origin);
      const rect = dragState.el.getBoundingClientRect();
      const left = rect.left - origin.x;
      const top = rect.top - origin.y;
      const guides = [];
      const rightAt = nearestEdge(left + w, lines.xs);
      if (rightAt) { w = Math.max(MIN_W, rightAt.at - left); guides.push({ axis: 'x', pos: origin.x + rightAt.at }); }
      const bottomAt = nearestEdge(top + h, lines.ys);
      if (bottomAt) { h = Math.max(MIN_H, bottomAt.at - top); guides.push({ axis: 'y', pos: origin.y + bottomAt.at }); }
      dragState.el.style.maxWidth = 'none';
      dragState.el.style.width = w + 'px';
      dragState.el.style.minHeight = h + 'px';
      // An explicit height is what makes a tile squarish: the content scrolls inside it
      // instead of pushing the card back to its natural height.
      dragState.el.style.height = h + 'px';
      drawSnapGuides(guides);
    }
    function finishResize(cardId) {
      if (!dragState || dragState.type !== 'resize' || dragState.cardId !== cardId) return;
      clearSnapGuides();
      const card = cards.find(c => c.id === cardId);
      if (card) { const rect = dragState.el.getBoundingClientRect(); updateCard(cardId, { width: rect.width, height: Math.max(MIN_H, rect.height) }); }
      dragState = null;
    }

    function showDockZones(excludeId) {
      document.querySelectorAll('.card-window').forEach(el => {
        if (el.dataset.id === excludeId) return;
        el.querySelectorAll('.dock-zone').forEach(z => z.classList.add('active'));
      });
    }
    function hideDockZones() {
      document.querySelectorAll('.dock-zone').forEach(z => z.classList.remove('active'));
      document.querySelectorAll('.card-window').forEach(el => el.classList.remove('docked'));
    }
    function highlightNearestDock(dragId, mx, my) {
      document.querySelectorAll('.card-window').forEach(el => {
        if (el.dataset.id === dragId) return;
        el.classList.remove('docked');
        const rect = el.getBoundingClientRect();
        const zones = [
          { edge: 'left', cx: rect.left - 10, cy: rect.top + rect.height/2 },
          { edge: 'right', cx: rect.right + 10, cy: rect.top + rect.height/2 },
          { edge: 'top', cx: rect.left + rect.width/2, cy: rect.top - 10 },
          { edge: 'bottom', cx: rect.left + rect.width/2, cy: rect.bottom + 10 },
        ];
        for (const z of zones) {
          if (Math.abs(mx - z.cx) < 25 && Math.abs(my - z.cy) < 25) { el.classList.add('docked'); break; }
        }
      });
    }
    function tryDock(dragId, mx, my) {
      let bestTarget = null, bestEdge = null, bestDist = 30;
      document.querySelectorAll('.card-window').forEach(el => {
        if (el.dataset.id === dragId) return;
        const rect = el.getBoundingClientRect();
        const zones = [
          { edge: 'left', cx: rect.left - 10, cy: rect.top + rect.height / 2 },
          { edge: 'right', cx: rect.right + 10, cy: rect.top + rect.height / 2 },
          { edge: 'top', cx: rect.left + rect.width / 2, cy: rect.top - 10 },
          { edge: 'bottom', cx: rect.left + rect.width / 2, cy: rect.bottom + 10 },
        ];
        zones.forEach(z => {
          const dist = Math.hypot(mx - z.cx, my - z.cy);
          if (dist < bestDist) { bestDist = dist; bestTarget = el.dataset.id; bestEdge = z.edge; }
        });
      });
      const dragEl = document.getElementById('card-' + dragId);
      if (!dragEl) return;
      const origin = canvasOrigin();
      const d = dragEl.getBoundingClientRect();
      const targetEl = bestTarget ? document.getElementById('card-' + bestTarget) : null;
      if (targetEl) {
        sendWS({ type: 'card:dock', sourceId: dragId, targetId: bestTarget, edge: bestEdge });
        const t = targetEl.getBoundingClientRect();
        // Flush and in canvas coordinates - the landing the guides already promised. The
        // old 8px gap was applied in viewport space, which is why a dock jumped on a
        // scrolled or offset canvas.
        let x = Math.round(d.left - origin.x);
        let y = Math.round(d.top - origin.y);
        if (bestEdge === 'left') { x = Math.round(t.left - origin.x - d.width); y = Math.round(t.top - origin.y); }
        else if (bestEdge === 'right') { x = Math.round(t.right - origin.x); y = Math.round(t.top - origin.y); }
        else if (bestEdge === 'top') { x = Math.round(t.left - origin.x); y = Math.round(t.top - origin.y - d.height); }
        else { x = Math.round(t.left - origin.x); y = Math.round(t.bottom - origin.y); }
        dragEl.style.left = x + 'px';
        dragEl.style.top = y + 'px';
        updateCard(dragId, { x: x, y: y, dockedTo: bestTarget, dockEdge: bestEdge });
        return;
      }
      updateCard(dragId, { x: Math.round(d.left - origin.x), y: Math.round(d.top - origin.y) });
    }

    function autoNumberDocuments() {
      const sorted = cards.filter(c => c.type === 'Document').sort((a, b) => {
        const ay = a.y || 0, by = b.y || 0;
        if (ay === by) return (a.x || 0) - (b.x || 0);
        return ay - by;
      });
      sorted.forEach((card, idx) => {
        const el = document.getElementById(\`card-\${card.id}\`);
        if (!el) return;
        const badge = el.querySelector('.card-type-badge');
        if (badge) badge.textContent = \`Doc \${idx + 1}\`;
      });
    }

    function openManipulate() { if (selectedIds.size === 0) { showToast('Select at least one card on the canvas first.', 'info'); return; } document.getElementById('selectedCount').textContent = \`\${selectedIds.size} card(s) selected.\`; document.getElementById('manipulateModal').style.display = 'flex'; }
    function closeManipulate() { document.getElementById('manipulateModal').style.display = 'none'; }

    async function runManipulate() {
      const action = document.getElementById('actionSelect').value;
      const promptText = document.getElementById('manipulatePrompt').value;
      const btn = document.getElementById('runBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Processing…';
      try {
        const res = await fetch(API('/cards/manipulate'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, cardIds: [...selectedIds], promptText }) });
        const newCard = await res.json();
        if (res.ok) { closeManipulate(); } else { alert('Error: ' + (newCard.error || 'Unknown')); }
      } catch (err) { alert('Request failed: ' + err.message); }
      finally { btn.disabled = false; btn.textContent = 'Run'; }
    }

    function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML; }

    // ── Markdown → HTML Renderer (for preview) ──
    function renderMarkdown(md) {
      let html = escapeHtml(md);
      // Code blocks (must be first to protect content)
      html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      // Headings
      html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
      html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
      html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      // Bold and italic
      html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      // Links and images
      html = html.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px;">');
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
      // Blockquotes
      html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
      // Horizontal rules
      html = html.replace(/^---$/gm, '<hr>');
      // Unordered lists
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
      // Ordered lists
      html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
      // Tables
      html = html.replace(/^\\|(.+)\\|$/gm, (match, content) => {
        const cells = content.split('|').map(c => c.trim());
        if (cells.every(c => c.match(/^[-:]+$/))) return '';
        const tag = 'td';
        return '<tr>' + cells.map(c => \`<\${tag}>\${c}</\${tag}>\`).join('') + '</tr>';
      });
      html = html.replace(/(<tr>.*<\\/tr>\\n?)+/g, '<table>$&</table>');
      // Paragraphs (double newline)
      html = html.replace(/\\n\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      // Single newlines to <br>
      html = html.replace(/\\n/g, '<br>');
      // Clean up empty paragraphs and nested tags
      html = html.replace(/<p><\\/p>/g, '');
      html = html.replace(/<p>(<h[1-6]>)/g, '$1');
      html = html.replace(/(<\\/h[1-6]>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<pre>)/g, '$1');
      html = html.replace(/(<\\/pre>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<ul>)/g, '$1');
      html = html.replace(/(<\\/ul>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<table>)/g, '$1');
      html = html.replace(/(<\\/table>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<hr>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<blockquote>)/g, '$1');
      html = html.replace(/(<\\/blockquote>)<\\/p>/g, '$1');
      return html;
    }

    // ── Card Mode Toggle (Edit / Preview / Split) ──
    function toggleCardMode(cardId, mode) {
      const el = document.getElementById(\`card-\${cardId}\`);
      if (!el) return;
      const textarea = el.querySelector(\`[data-content="\${cardId}"]\`);
      const preview = el.querySelector(\`[data-preview="\${cardId}"]\`);
      const rawContent = el.querySelector(\`[data-rawcontent="\${cardId}"]\`);
      const fmtBar = el.querySelector(\`[data-fmtbar="\${cardId}"]\`);
      if (!textarea || !preview) return;
      const buttons = el.querySelectorAll('.card-toolbar button');
      buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      if (rawContent) {
        if (mode === 'edit') {
          rawContent.style.display = 'none';
          textarea.style.display = 'block';
          preview.style.display = 'none';
          if (fmtBar) fmtBar.style.display = 'flex';
          textarea.focus();
        } else {
          rawContent.style.display = 'block';
          textarea.style.display = 'none';
          preview.style.display = 'none';
          if (fmtBar) fmtBar.style.display = 'none';
        }
        updateCard(cardId, { splitView: false });
      } else if (mode === 'split') {
        textarea.style.display = 'block';
        preview.style.display = 'block';
        if (fmtBar) fmtBar.style.display = 'flex';
        preview.innerHTML = renderMarkdown(textarea.value);
        updateCard(cardId, { splitView: true });
      } else if (mode === 'preview') {
        textarea.style.display = 'none';
        preview.style.display = 'block';
        if (fmtBar) fmtBar.style.display = 'none';
        preview.innerHTML = renderMarkdown(textarea.value);
        updateCard(cardId, { splitView: false });
      } else {
        textarea.style.display = 'block';
        preview.style.display = 'none';
        if (fmtBar) fmtBar.style.display = 'flex';
        textarea.focus();
        updateCard(cardId, { splitView: false });
      }
    }

    // ── Format Toolbar Actions ──
    function getCardTextarea(cardId) {
      const el = document.getElementById(\`card-\${cardId}\`);
      return el ? el.querySelector(\`[data-content="\${cardId}"]\`) : null;
    }

    function fmtInsert(cardId, before, after, placeholder) {
      const ta = getCardTextarea(cardId);
      if (!ta) return;
      // Switch to edit mode first
      const el = document.getElementById(\`card-\${cardId}\`);
      const editBtn = el?.querySelector('[data-mode="edit"]');
      if (editBtn && !editBtn.classList.contains('active')) editBtn.click();
      ta.focus();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = ta.value.substring(start, end);
      const text = selected || placeholder || '';
      const insertion = before + text + (after || '');
      ta.value = ta.value.substring(0, start) + insertion + ta.value.substring(end);
      if (selected) {
        ta.selectionStart = start + before.length;
        ta.selectionEnd = start + before.length + text.length;
      } else {
        ta.selectionStart = start + before.length;
        ta.selectionEnd = start + before.length + (placeholder || '').length;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function fmtBold(cardId) { fmtInsert(cardId, '**', '**', 'bold text'); }
    function fmtItalic(cardId) { fmtInsert(cardId, '*', '*', 'italic text'); }
    function fmtStrike(cardId) { fmtInsert(cardId, '~~', '~~', 'strikethrough'); }
    function fmtCode(cardId) { fmtInsert(cardId, '\`', '\`', 'code'); }
    function fmtLink(cardId) { fmtInsert(cardId, '[', '](https://)', 'link text'); }
    function fmtImage(cardId) { fmtInsert(cardId, '![', '](https://)', 'alt text'); }
    function fmtHr(cardId) { fmtInsert(cardId, '\\n\\n---\\n\\n', '', ''); }
    function fmtQuote(cardId) { fmtInsert(cardId, '\\n> ', '\\n', 'quote'); }
    function fmtCodeBlock(cardId) { fmtInsert(cardId, '\\n\`\`\`\\n', '\\n\`\`\`\\n', 'code block'); }
    function fmtList(cardId) { fmtInsert(cardId, '\\n- ', '\\n', 'list item'); }
    function fmtOList(cardId) { fmtInsert(cardId, '\\n1. ', '\\n', 'list item'); }
    function fmtHeading(cardId, level) {
      const prefix = '#'.repeat(level) + ' ';
      fmtInsert(cardId, '\\n' + prefix, '\\n', 'heading');
    }

    // A browser card carries the page's own title when it had one. When it did not,
    // the field showed the word "undefined"; the URL says more.
    function hostOf(url) {
      try { return new URL(String(url || '')).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
    }
    function cardTitleText(card) {
      const title = String(card && card.title != null ? card.title : '').trim();
      if (!title || title === 'undefined' || title === 'null') return '';
      return title;
    }
    function cardTitleHint(card) {
      return hostOf(card && card.url) || (card && card.type ? card.type + ' card' : 'Untitled');
    }

    // A phone-shaped page laid out at 430px and scaled into whatever the card is:
    // a clipped wheel and a half button are worse than smaller type.
    const BROWSER_LAYOUT_WIDTH = 430;
    function fitBrowserFrame(frame) {
      const viewer = frame && frame.closest ? frame.closest('.browser-viewer') : null;
      if (!viewer) return;
      const width = viewer.clientWidth;
      const height = viewer.clientHeight;
      if (!width || !height) return;
      const scale = Math.min(1, width / BROWSER_LAYOUT_WIDTH);
      frame.style.width = Math.round(width / scale) + 'px';
      frame.style.height = Math.round(height / scale) + 'px';
      frame.style.transformOrigin = 'top left';
      frame.style.transform = scale < 1 ? 'scale(' + scale.toFixed(4) + ')' : 'none';
    }
    function fitBrowserFrames(root) {
      const scope = root && root.querySelectorAll ? root : document;
      scope.querySelectorAll('iframe[data-browser-frame]').forEach((frame) => {
        fitBrowserFrame(frame);
        const viewer = frame.closest('.browser-viewer');
        if (!viewer || !window.ResizeObserver || viewer.dataset.fitWatched) return;
        viewer.dataset.fitWatched = '1';
        new ResizeObserver(() => fitBrowserFrame(frame)).observe(viewer);
      });
    }
    window.addEventListener('resize', () => fitBrowserFrames(document));

    // A card you already know by name should not need its whole address typed:
    // "mind" and "mind.ai-n.workers.dev" both mean the same page.
    const BARE_NAME = /^[a-z0-9][a-z0-9-]*$/i;
    function resolveAddress(raw) {
      const value = String(raw || '').trim();
      if (!value) return '';
      if (/^https?:\\/\\//i.test(value)) return value;
      if (value.indexOf(' ') === -1 && value.indexOf('.') !== -1) return 'https://' + value;
      if (BARE_NAME.test(value)) return 'https://' + value + '.ai-n.workers.dev';
      return 'https://' + value;
    }

    // ── Browser Navigation ──
    function browserNavigate(cardId) {
      const el = document.getElementById(\`card-\${cardId}\`);
      if (!el) return;
      const urlInput = el.querySelector(\`[data-url-input="\${cardId}"]\`);
      if (!urlInput) return;
      const url = resolveAddress(urlInput.value);
      if (!url) return;
      urlInput.value = url;
      // Update the iframe
      const frame = el.querySelector(\`[data-browser-frame="\${cardId}"]\`);
      if (frame) {
        frame.src = \`/api/proxy?url=\${encodeURIComponent(url)}\`;
      } else {
        // Create iframe if it doesn't exist
        const viewer = el.querySelector('.browser-viewer');
        if (viewer) {
          viewer.innerHTML = \`<iframe data-browser-frame="\${cardId}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" src="/api/proxy?url=\${encodeURIComponent(url)}" style="width:100%;height:100%;border:none;"></iframe>\`;
        }
      }
      fitBrowserFrames(el);
      // Save URL to card
      updateCard(cardId, { url });
    }

    function openBrowserFullscreen(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card || !card.url) { showToast('No URL to open', 'warning'); return; }
      const proxyUrl = \`/api/proxy?url=\${encodeURIComponent(card.url)}&ws=\${wsParam}\`;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#0d0d1a;z-index:200;display:flex;flex-direction:column;';
      overlay.innerHTML = \`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #2a2a4a;">
          <span style="color:#4ab8ff;font-size:12px;font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${escapeHtml(card.url)}</span>
          <button onclick="this.closest('[style*=fixed]').remove()" style="padding:4px 12px;background:#4a1a1a;color:#ff4a4a;border:1px solid #6a2a2a;border-radius:4px;font-size:12px;cursor:pointer;">Close</button>
        </div>
        <iframe src="\${proxyUrl}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" style="flex:1;width:100%;border:none;background:#fff;"></iframe>
      \`;
      document.body.appendChild(overlay);
    }

    function openCardFullscreen(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) { showToast('Card not found', 'warning'); return; }
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#0d0d1a;z-index:200;display:flex;flex-direction:column;';
      const isMarkdown = card.type === 'Document' || card.type === 'Import' || card.type === 'Search';
      const bodyHtml = isMarkdown
        ? \`<div class="md-preview" style="flex:1;overflow:auto;padding:24px 32px;">\${renderMarkdown(card.content || '')}</div>\`
        : \`<pre style="flex:1;overflow:auto;padding:24px 32px;color:#e0e0e0;font-family:monospace;font-size:13px;white-space:pre-wrap;word-wrap:break-word;">\${escapeHtml(card.content || '')}</pre>\`;
      overlay.innerHTML = \`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #2a2a4a;">
          <span class="card-type-badge badge-\${card.type.toLowerCase()}">\${card.type}</span>
          <span style="color:#ccc;font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${escapeHtml(card.title)}</span>
          <button onclick="openCardFullscreenEdit('\${card.id}')" style="padding:4px 12px;background:#22223a;color:#4ab8ff;border:1px solid #2a2a4a;border-radius:4px;font-size:12px;cursor:pointer;">Edit</button>
          <button onclick="this.closest('[style*=fixed]').remove()" style="padding:4px 12px;background:#4a1a1a;color:#ff4a4a;border:1px solid #6a2a2a;border-radius:4px;font-size:12px;cursor:pointer;">Close</button>
        </div>
        \${bodyHtml}
      \`;
      document.body.appendChild(overlay);
    }

    function openCardFullscreenEdit(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#0d0d1a;z-index:200;display:flex;flex-direction:column;';
      overlay.innerHTML = \`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #2a2a4a;">
          <span style="color:#ccc;font-size:13px;font-weight:600;flex:1;">Edit \${escapeHtml(card.title)}</span>
          <button onclick="this.closest('[style*=fixed]').remove()" style="padding:4px 12px;background:#4a1a1a;color:#ff4a4a;border:1px solid #6a2a2a;border-radius:4px;font-size:12px;cursor:pointer;">Close</button>
        </div>
        <textarea data-fullscreen-edit="\${card.id}" style="flex:1;width:100%;background:#0d0d1a;color:#e0e0e0;border:none;padding:16px 20px;font-size:14px;font-family:'SF Mono','Fira Code',monospace;line-height:1.7;resize:none;outline:none;">\${escapeHtml(card.content || '')}</textarea>
      \`;
      document.body.appendChild(overlay);
      const ta = overlay.querySelector(\`[data-fullscreen-edit="\${card.id}"]\`);
      ta.focus();
      let debounce;
      ta.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => updateCard(card.id, { content: ta.value }), 400);
      });
    }

    // ── Toast Notifications ──
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = \`toast toast-\${type}\`;
      const icons = { success: '✓', error: '✕', info: 'ℹ', processing: '⟳' };
      toast.innerHTML = \`<span>\${icons[type] || 'ℹ'}</span> \${escapeHtml(message)}\`;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3200);
    }
    function showSpinner(msg) { showToast(msg || 'Working...', 'processing'); }
    function hideSpinner() {}

    // ── HTML → Markdown Converter ──
    function htmlToMarkdown(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      function convertNode(node) {
        if (node.nodeType === 3) {
          return node.textContent.replace(/\\s+/g, ' ');
        }
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        const inner = Array.from(node.childNodes).map(convertNode).join('');
        switch (tag) {
          case 'h1': return \`\\n# \${inner.trim()}\\n\`;
          case 'h2': return \`\\n## \${inner.trim()}\\n\`;
          case 'h3': return \`\\n### \${inner.trim()}\\n\`;
          case 'h4': return \`\\n#### \${inner.trim()}\\n\`;
          case 'h5': return \`\\n##### \${inner.trim()}\\n\`;
          case 'h6': return \`\\n###### \${inner.trim()}\\n\`;
          case 'p': return \`\\n\${inner.trim()}\\n\`;
          case 'br': return '\\n';
          case 'strong': case 'b': return \`**\${inner.trim()}**\`;
          case 'em': case 'i': return \`*\${inner.trim()}*\`;
          case 'code': return \`\\\`\${inner}\\\`\`;
          case 'pre': return \`\\n\\\`\\\`\\\`\\n\${inner.trim()}\\n\\\`\\\`\\\`\\n\`;
          case 'a': { const href = node.getAttribute('href'); return href ? \`[\${inner.trim()}](\${href})\` : inner; }
          case 'img': { const alt = node.getAttribute('alt') || 'image'; const src = node.getAttribute('src') || ''; return \`![\${alt}](\${src})\`; }
          case 'ul': return '\\n' + inner + '\\n';
          case 'ol': return '\\n' + inner + '\\n';
          case 'li': {
            const parent = node.parentElement;
            if (parent && parent.tagName.toLowerCase() === 'ol') {
              const idx = Array.from(parent.children).indexOf(node) + 1;
              return \`\${idx}. \${inner.trim()}\\n\`;
            }
            return \`- \${inner.trim()}\\n\`;
          }
          case 'blockquote': return '\\n> ' + inner.trim().replace(/\\n/g, '\\n> ') + '\\n';
          case 'hr': return '\\n---\\n';
          case 'table': {
            const rows = Array.from(node.querySelectorAll('tr'));
            if (rows.length === 0) return inner;
            let md = '\\n';
            rows.forEach((row, ri) => {
              const cells = Array.from(row.querySelectorAll('th, td')).map(c => c.textContent.trim());
              md += '| ' + cells.join(' | ') + ' |\\n';
              if (ri === 0) md += '| ' + cells.map(() => '---').join(' | ') + ' |\\n';
            });
            return md + '\\n';
          }
          case 'div': case 'section': case 'article': case 'main': case 'span': case 'mark': case 'del': case 's': case 'u': case 'sub': case 'sup': case 'small': case 'strong': case 'em':
            return inner;
          case 'script': case 'style': case 'nav': case 'footer': case 'header': case 'aside': case 'form': case 'input': case 'button': case 'select': case 'textarea':
            return '';
          default: return inner;
        }
      }
      let md = Array.from(doc.body.childNodes).map(convertNode).join('');
      md = md.replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+/g, ' ').trim();
      return md;
    }

    // ── Image Compression ──
    function compressImage(file, maxWidth = 1200, quality = 0.85) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            if (img.width <= maxWidth && file.size < 2 * 1024 * 1024) {
              resolve(e.target.result);
              return;
            }
            const canvas = document.createElement('canvas');
            const scale = img.width > maxWidth ? maxWidth / img.width : 1;
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', quality));
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    // ── File Processing (frontend) ──
    async function processFile(file) {
      const name = file.name || 'Pasted file';
      const type = file.type || '';
      const ext = name.split('.').pop().toLowerCase();

      if (type.startsWith('image/') || ['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext)) {
        showToast('Processing image…', 'processing');
        const dataUrl = await compressImage(file);
        const base64 = dataUrl.split(',')[1];
        await createCard('Document', name, \`![\${name}](\${dataUrl})\`);
        showToast('Image imported', 'success');
        return;
      }

      if (type === 'text/markdown' || type === 'text/x-markdown' || ext === 'md' || ext === 'markdown') {
        const text = await file.text();
        const card = await createCard('Document', name, text);
        showToast('Markdown imported', 'success');
        return;
      }

      if (type === 'text/html' || ext === 'html' || ext === 'htm') {
        const html = await file.text();
        const md = htmlToMarkdown(html);
        const card = await createCard('Document', name, md);
        showToast('HTML imported as Markdown', 'success');
        return;
      }

      if (type === 'text/plain' || ext === 'txt') {
        const text = await file.text();
        await createCard('Document', name, text);
        showToast('Text imported', 'success');
        return;
      }

      if (type === 'application/pdf' || ext === 'pdf' ||
          type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
        showToast(\`Processing \${ext.toUpperCase()} — this may take a moment…\`, 'processing');
        try {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const res = await fetch(API('/import'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: name, mimeType: type || (ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), data: base64 })
          });
          const card = await res.json();
          if (res.ok) {
            showToast(\`\${ext.toUpperCase()} imported successfully\`, 'success');
          } else {
            showToast(\`Import failed: \${card.error}\`, 'error');
          }
        } catch (err) {
          showToast(\`Import failed: \${err.message}\`, 'error');
        }
        return;
      }

      showToast(\`Unsupported file type: \${type || ext}\`, 'error');
    }

    // ── Paste Handler ──
    document.addEventListener('paste', async (e) => {
      const active = document.activeElement;
      const isEditing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      // Files on clipboard (images, documents) — FileList is always truthy, must check length
      const files = clipboardData.files;
      if (files && files.length > 0) {
        e.preventDefault();
        for (const file of files) {
          await processFile(file);
        }
        return;
      }

      // Rich HTML paste INTO a textarea — convert to markdown and insert
      if (isEditing && active.tagName === 'TEXTAREA') {
        const html = clipboardData.getData('text/html');
        if (html && html.trim().length > 10) {
          e.preventDefault();
          const md = htmlToMarkdown(html);
          if (md.trim().length > 0) {
            const start = active.selectionStart;
            const end = active.selectionEnd;
            const before = active.value.substring(0, start);
            const after = active.value.substring(end);
            active.value = before + md + after;
            active.selectionStart = active.selectionEnd = start + md.length;
            active.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return;
        }
        // Plain text paste into textarea — let browser handle it normally
        return;
      }

      // HTML content outside textarea — create a new card
      const html = clipboardData.getData('text/html');
      if (html && html.trim().length > 10 && !isEditing) {
        e.preventDefault();
        const md = htmlToMarkdown(html);
        if (md.trim().length > 0) {
          const title = extractTitleFromHtml(html) || 'Pasted Content';
          await createCard('Document', title, md);
          showToast('Content imported as Markdown', 'success');
        }
        return;
      }

      // Plain text outside textarea — create a new card
      if (!isEditing) {
        const text = clipboardData.getData('text/plain');
        if (text && text.trim().length > 0) {
          e.preventDefault();
          const title = text.split('\\n')[0].slice(0, 60).trim() || 'Pasted Text';
          await createCard('Document', title, text);
          showToast('Text imported', 'success');
        }
      }
    });

    function extractTitleFromHtml(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const h1 = doc.querySelector('h1');
      if (h1) return h1.textContent.trim().slice(0, 60);
      const b = doc.querySelector('b, strong');
      if (b && b.textContent.trim().length > 3) return b.textContent.trim().slice(0, 60);
      const first = doc.body.textContent.trim().split('\\n')[0];
      return first ? first.slice(0, 60).trim() : null;
    }

    // --- Search Card ---
    function openSearch() { document.getElementById('searchModal').style.display = 'flex'; document.getElementById('searchQuery').focus(); }
    function closeSearch() { document.getElementById('searchModal').style.display = 'none'; }
    async function runSearch() {
      const q = document.getElementById('searchQuery').value.trim(); if (!q) return;
      const btn = document.getElementById('searchBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const res = await fetch(API('/search'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
        const results = await res.json();
        const container = document.getElementById('searchResults'); container.style.display = 'block';
        container.innerHTML = (results.hits || []).map(r => \`
          <div class="search-result-item" onclick="materializeSearchResult('\${escapeHtml(r.title)}', '\${escapeHtml(r.snippet || '')}', '\${escapeHtml(r.url || '')}')">
            <div class="result-title">\${escapeHtml(r.title)}</div>
            <div class="result-snippet">\${escapeHtml((r.snippet || '').slice(0, 120))}</div>
            \${r.url ? '<div class="result-snippet" style="color:#4a9aff;font-size:10px;">' + escapeHtml(r.url) + '</div>' : ''}
          </div>
        \`).join('') || '<div class="text-xs text-gray-500 p-2">No results</div>';
      } catch(e) { showToast('Search failed: ' + e.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Search'; }
    }
    function materializeSearchResult(title, snippet, url) {
      closeSearch();
      createCard({ type: 'Document', title, content: snippet + (url ? ' — source: ' + url : ''), url: url || undefined });
    }
    async function runCardSearch(cardId) {
      const el = document.getElementById(\`card-\${cardId}\`);
      const input = el?.querySelector(\`[data-search-input="\${cardId}"]\`);
      const results = el?.querySelector(\`[data-search-results="\${cardId}"]\`);
      if (!input || !results) return;
      const q = input.value.trim(); if (!q) return;
      try {
        const res = await fetch(API('/search'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
        const data = await res.json();
        results.innerHTML = (data.hits || []).map(r => \`
          <div class="search-result-item" onclick="materializeSearchResult('\${escapeHtml(r.title)}', '\${escapeHtml(r.snippet || '')}', '\${escapeHtml(r.url || '')}')">
            <div class="result-title">\${escapeHtml(r.title)}</div>
            <div class="result-snippet">\${escapeHtml((r.snippet || '').slice(0, 120))}</div>
            \${r.url ? '<div class="result-snippet" style="color:#4a9aff;font-size:10px;">' + escapeHtml(r.url) + '</div>' : ''}
          </div>
        \`).join('') || '<div class="text-xs text-gray-500 p-2">No results</div>';
      } catch(e) { results.innerHTML = '<div class="text-xs text-red-400 p-2">Search failed</div>'; }
    }

    // --- Principle Engine (frontend) ---
    let pendingPrinciple = null;
    function showPrincipleProposal(principle) {
      pendingPrinciple = principle;
      document.getElementById('principlePreview').textContent = principle.text;
      document.getElementById('principleEditText').value = principle.text;
      document.getElementById('principleDomain').value = principle.domainTag || 'legal';
      document.getElementById('principleModal').style.display = 'flex';
    }
    function closePrinciple() { document.getElementById('principleModal').style.display = 'none'; pendingPrinciple = null; }
    function killPrinciple() {
      if (!pendingPrinciple) return;
      fetch(API('/principles/kill'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pendingPrinciple.id }) })
        .then(r => r.json()).then(data => {
          if (data.immutable) { showToast('Constitutional immutability: this principle cannot be removed', 'error'); return; }
          showToast('Principle killed', 'info');
        });
      closePrinciple();
    }
    async function ratifyPrinciple(action) {
      if (!pendingPrinciple) return;
      const editedText = document.getElementById('principleEditText').value.trim();
      const domain = document.getElementById('principleDomain').value;
      const res = await fetch(API('/principles'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: pendingPrinciple.id, text: editedText || pendingPrinciple.text, domainTag: domain,
        sourceCardId: pendingPrinciple.sourceCardId, sourceCitation: pendingPrinciple.sourceCitation,
        ratificationStatus: (domain === 'universal' || domain === 'ethical') ? 'auto' : 'expert',
        action
      })});
      if (res.ok) { showToast('Principle ratified', 'success'); closePrinciple(); loadPrinciples(); }
      else { showToast('Ratification failed', 'error'); }
    }
    async function loadPrinciples() {
      try { const res = await fetch(API('/principles')); const data = await res.json(); principles = data.principles || []; renderPrincipleBadges(); } catch {}
    }
    function getCardPrincipleBadges(card) {
      const applicable = principles.filter(p => {
        if (p.domainTag === 'universal' || p.domainTag === 'ethical') return true;
        return card.domains && card.domains.includes(p.domainTag);
      });
      if (applicable.length === 0) return '';
      const autoCount = applicable.filter(p => p.ratificationStatus === 'auto').length;
      const expertCount = applicable.filter(p => p.ratificationStatus === 'expert').length;
      let html = '';
      if (autoCount) html += \`<span class="principle-badge principle-auto">✓ \${autoCount}</span>\`;
      if (expertCount) html += \`<span class="principle-badge principle-expert">★ \${expertCount}</span>\`;
      return html;
    }
    function renderPrincipleBadges() {
      document.querySelectorAll('.card-window').forEach(el => {
        const card = cards.find(c => c.id === el.dataset.id);
        if (!card) return;
        const header = el.querySelector('.card-header .flex');
        if (!header) return;
        const existing = header.querySelector('.principle-badge');
        if (existing) existing.parentElement.removeChild(existing);
        const html = getCardPrincipleBadges(card);
        if (html) { const span = document.createElement('span'); span.innerHTML = html; header.appendChild(span); }
      });
    }

    // --- Import card classification ---
    async function classifyImportContent(cardId, content) {
      try {
        const res = await fetch(API('/classify'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, content: content.slice(0, 2000) }) });
        const data = await res.json();
        const el = document.querySelector(\`[data-import-classification="\${cardId}"]\`);
        if (el && data.classification) {
          el.innerHTML = \`<div class="text-xs text-cyan-300">🔧 Domain: \${data.classification.domain} | Principles: \${data.classification.principles.length} proposed</div>\`;
          if (data.classification.principles.length > 0) {
            data.classification.principles.forEach(p => showPrincipleProposal(p));
          }
        }
      } catch {}
    }

    // --- Phase 2: Instruct Card Routing ---
    async function runInstruct(cardId) {
      const card = cards.find(c => c.id === cardId);
      const el = document.getElementById(\`card-\${cardId}\`);
      if (!card || !el) return;
      const textarea = el.querySelector(\`[data-content="\${cardId}"]\`);
      const output = el.querySelector(\`[data-instruct-output="\${cardId}"]\`);
      if (!textarea || !output) return;
      const instruction = textarea.value.trim();
      if (!instruction) { output.innerHTML = '<div class="text-xs text-red-400">Enter an instruction first.</div>'; return; }
      output.innerHTML = '<div class="text-xs text-yellow-400"><span class="spinner"></span> Routing through principle stack...</div>';
      try {
        const res = await fetch(API('/instruct'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, instruction, domains: card.domains || [] }) });
        const data = await res.json();
        if (data.error) { output.innerHTML = \`<div class="text-xs text-red-400">\${data.error}</div>\`; return; }
        output.innerHTML = \`
          <div class="md-preview" style="max-height:250px;overflow-y:auto;">\${renderMarkdown(data.result || '')}</div>
          <div style="margin-top:6px;display:flex;gap:6px;">
            <button onclick="adoptInstructResult('\${cardId}', this.parentElement.previousElementSibling)" class="action-btn" style="font-size:10px;padding:3px 8px;">Adopt as Content</button>
            <span class="text-xs text-gray-500">Confidence: \${data.confidence || 'N/A'}</span>
          </div>
        \`;
      } catch(e) { output.innerHTML = \`<div class="text-xs text-red-400">Failed: \${e.message}</div>\`; }
    }
    function adoptInstructResult(cardId, previewEl) {
      const text = previewEl?.textContent || '';
      const card = cards.find(c => c.id === cardId);
      const el = document.getElementById(\`card-\${cardId}\`);
      if (!card || !el) return;
      const textarea = el.querySelector(\`[data-content="\${cardId}"]\`);
      if (textarea) { textarea.value = text; updateCard(cardId, { content: text }); }
    }
    async function checkPrincipleCompliance(cardId) {
      const card = cards.find(c => c.id === cardId);
      const el = document.getElementById(\`card-\${cardId}\`);
      if (!card || !el) return;
      const textarea = el.querySelector(\`[data-content="\${cardId}"]\`);
      const output = el.querySelector(\`[data-instruct-output="\${cardId}"]\`);
      if (!textarea || !output) return;
      const content = textarea.value.trim();
      if (!content) return;
      output.innerHTML = '<div class="text-xs text-yellow-400"><span class="spinner"></span> Checking compliance...</div>';
      try {
        const res = await fetch(API('/compliance'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, content }) });
        const data = await res.json();
        const violations = data.violations || [];
        const suggestions = data.suggestions || [];
        let html = '';
        if (violations.length > 0) {
          html += '<div style="margin-bottom:6px;"><span class="text-xs font-bold text-red-400">Violations:</span>';
          violations.forEach(v => { html += \`<div class="text-xs text-red-300 ml-2">⚠ \${v}</div>\`; });
          html += '</div>';
        }
        if (suggestions.length > 0) {
          html += '<div><span class="text-xs font-bold text-yellow-400">Suggestions:</span>';
          suggestions.forEach(s => { html += \`<div class="text-xs text-yellow-300 ml-2">ℹ \${s}</div>\`; });
          html += '</div>';
        }
        if (!html) html = '<div class="text-xs text-green-400">✓ Content complies with all active principles.</div>';
        output.innerHTML = html;
      } catch(e) { output.innerHTML = \`<div class="text-xs text-red-400">Failed: \${e.message}</div>\`; }
    }

    // --- Phase 3: Domain Awareness ---
    let activeDomainStack = { primary: 'general', secondary: [] };
    function setDomain(cardId, domain) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const domains = [domain];
      if (card.domains && card.domains.length > 1) domains.push(card.domains[1]);
      updateCard(cardId, { domains });
      activeDomainStack.primary = domain;
      showToast(\`Domain set to \${domain}\`, 'info');
      renderPrincipleBadges();
    }
    function getActiveDomainStack() { return activeDomainStack; }

    // --- Phase 3: Split View Live Rendering ---
    function setupSplitViewLiveRendering(cardId) {
      const el = document.getElementById(\`card-\${cardId}\`);
      if (!el) return;
      const textarea = el.querySelector(\`[data-content="\${cardId}"]\`);
      const preview = el.querySelector(\`[data-preview="\${cardId}"]\`);
      if (!textarea || !preview) return;
      textarea.addEventListener('input', () => {
        preview.innerHTML = renderMarkdown(textarea.value);
      });
      preview.innerHTML = renderMarkdown(textarea.value);
    }

    // --- Phase 4: BASE Confidence Scoring ---
    let confidenceScores = {};
    async function computeConfidence(cardId) {
      try {
        const res = await fetch(API('/confidence'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId }) });
        const data = await res.json();
        confidenceScores[cardId] = data;
        updateConfidenceDisplay(cardId, data);
        return data;
      } catch { return null; }
    }
    function updateConfidenceDisplay(cardId, score) {
      const el = document.getElementById(\`card-\${cardId}\`);
      if (!el || !score) return;
      let badge = el.querySelector('[data-confidence]');
      if (!badge) {
        badge = document.createElement('div');
        badge.dataset.confidence = cardId;
        badge.style.cssText = 'position:absolute;top:8px;right:40px;font-size:9px;padding:2px 6px;border-radius:3px;font-weight:600;z-index:10;';
        el.appendChild(badge);
      }
      const total = score.total || 0;
      const isEitl = score.eitlUnlocked;
      const color = total >= 0.8 ? '#4aff8a' : total >= 0.5 ? '#ffaa4a' : '#ff4a4a';
      badge.style.background = isEitl ? '#1a4a2a44' : '#1a1a2e';
      badge.style.color = color;
      badge.style.border = \`1px solid \${color}44\`;
      badge.textContent = \`\${(total * 100).toFixed(0)}%\${isEitl ? ' EITL' : ''}\`;
    }

    // --- Phase 4: EITL Expert Review ---
    let pendingReview = null;
    function openExpertReview(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      pendingReview = cardId;
      document.getElementById('eitlReviewContent').textContent = card.content;
      document.getElementById('eitlReviewModal').style.display = 'flex';
    }
    function closeExpertReview() { document.getElementById('eitlReviewModal').style.display = 'none'; pendingReview = null; }
    async function submitEitlReview(action) {
      if (!pendingReview) return;
      const comment = document.getElementById('eitlReviewComment').value;
      const res = await fetch(API('/eitl/review'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: pendingReview, action, comment }) });
      if (res.ok) { showToast(\`Output \${action}\`, 'success'); closeExpertReview(); computeConfidence(pendingReview); }
    }

    function rewriteUrls(html, baseUrl) {
      if (!baseUrl) return html;
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const base = new URL(baseUrl);
        doc.querySelectorAll('a[href]').forEach(a => {
          try { a.href = new URL(a.getAttribute('href'), base).href; } catch {}
        });
        doc.querySelectorAll('img[src]').forEach(img => {
          try { img.src = new URL(img.getAttribute('src'), base).href; } catch {}
        });
        doc.querySelectorAll('link[href]').forEach(link => {
          try { link.href = new URL(link.getAttribute('href'), base).href; } catch {}
        });
        doc.querySelectorAll('script[src]').forEach(s => {
          try { s.src = new URL(s.getAttribute('src'), base).href; } catch {}
        });
        // Add base target for links
        doc.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
        return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#222;padding:16px;max-width:100%;overflow-x:auto;}img{max-width:100%;height:auto;border-radius:4px;}a{color:#0066cc;}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;}code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:13px;}blockquote{border-left:3px solid #ccc;padding-left:12px;color:#555;margin:8px 0;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;}th{background:#f5f5f5;}</style></head><body>' + doc.body.innerHTML + '</body></html>';
      } catch { return html; }
    }

    // ── Drag & Drop ──
    let dragCounter = 0;
    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        if (dragCounter === 1) document.getElementById('dropOverlay').style.display = 'flex';
      }
    });
    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; document.getElementById('dropOverlay').style.display = 'none'; }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      document.getElementById('dropOverlay').style.display = 'none';
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (const file of e.dataTransfer.files) {
          await processFile(file);
        }
      }
    });

    // ── File Upload Button ──
    document.getElementById('fileUpload').addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files) return;
      for (const file of files) {
        await processFile(file);
      }
      e.target.value = '';
    });

    // ── Paste Hint ──
    setTimeout(() => {
      const hint = document.getElementById('pasteHint');
      hint.classList.add('visible');
      setTimeout(() => hint.classList.remove('visible'), 4000);
    }, 1500);

    // ── Truth-Engine Query ──
    function promptQuery() {
      promptQueryWithKVPicker();
    }
    async function promptQueryWithKVPicker() {
      showSpinner('Loading KV entries...');
      let entries = [];
      try {
        const res = await fetch(API('/kv/all'));
        const data = await res.json();
        entries = data.entries || [];
      } catch (e) {
        hideSpinner();
        showToast('Failed to load KV entries: ' + e.message, 'error');
        return;
      }
      hideSpinner();
      const cardId = 'card_' + crypto.randomUUID();
      const grouped = {};
      for (const e of entries) {
        if (!grouped[e.ns]) grouped[e.ns] = [];
        grouped[e.ns].push(e);
      }
      let listHtml = '<input class="kv-picker-search" type="text" placeholder="Filter entries..." data-kv-search="' + cardId + '" />';
      for (const [ns, items] of Object.entries(grouped)) {
        const nsShort = ns.replace('_KV','').replace('KV_','');
        const grpId = cardId + '_' + ns;
        listHtml += '<div class="kv-picker-group" data-kv-group="' + ns + '" data-kv-group-card="' + cardId + '">'
          + '<div class="kv-picker-group-header" style="cursor:pointer;" onclick="const el=document.getElementById(\\'gitems-' + grpId + '\\');const arrow=document.getElementById(\\'garrow-' + grpId + '\\');if(el.style.display===\\'none\\'){el.style.display=\\'block\\';arrow.style.transform=\\'rotate(0deg)\\';}else{el.style.display=\\'none\\';arrow.style.transform=\\'rotate(-90deg)\\';}">'
          + '<span id="garrow-' + grpId + '" class="arrow" style="display:inline-block;transform:rotate(-90deg);transition:transform 0.15s;">▼</span> ' + nsShort + ' <span style="color:#666;font-weight:400;">(' + items.length + ')</span>'
          + '</div>'
          + '<div id="gitems-' + grpId + '" class="kv-picker-group-items" style="display:none;">';
        for (const item of items) {
          const preview = typeof item.value === 'object' ? JSON.stringify(item.value).slice(0, 80) : String(item.value).slice(0, 80);
          listHtml += '<label class="kv-picker-item" data-kv-id="' + item.id + '" data-kv-group-card="' + cardId + '">'
            + '<input type="checkbox" class="kv-check" data-ns="' + item.ns + '" data-key="' + item.key + '" data-id="' + item.id + '">'
            + '<div style="flex:1;min-width:0;"><div class="kv-key">' + escapeHtml(item.key) + '</div><div class="kv-preview">' + escapeHtml(preview) + '</div></div>'
            + '</label>';
        }
        listHtml += '</div></div>';
      }
      if (entries.length === 0) listHtml += '<div style="color:#666;font-size:11px;padding:12px;text-align:center;">No KV entries found.</div>';
      const card = {
        id: cardId,
        type: 'Query',
        title: '🔎 New Query — Select KV Sources',
        content: '',
        queryText: '',
        domains: ['general'],
        results: [],
        coverageScore: 0,
        principlesApplied: [],
        kvPickerEntries: entries,
        splitView: false,
      };
      card._pickerHtml = '<div style="padding:4px 0;">'
        + '<div style="font-size:10px;color:#888;margin-bottom:4px;">Select KV entries to query against (' + entries.length + ' total)</div>'
        + '<div class="kv-picker-controls">'
        + '<button onclick="kvPickerSelectAll(\\'' + cardId + '\\')" class="ctrl-btn" style="font-size:10px;padding:2px 6px;">Select All</button>'
        + '<button onclick="kvPickerSelectNone(\\'' + cardId + '\\')" class="ctrl-btn" style="font-size:10px;padding:2px 6px;">None</button>'
        + '<span id="kv-picker-count-' + cardId + '" style="font-size:10px;color:#888;margin-left:auto;">0 selected</span>'
        + '</div>'
        + '<div class="kv-picker" data-kv-picker="' + cardId + '">' + listHtml + '</div>'
        + '<div style="margin-top:8px;">'
        + '<textarea id="kv-query-input-' + cardId + '" placeholder="Enter query text..." style="width:100%;background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:6px;padding:6px 8px;font-size:12px;min-height:48px;resize:vertical;font-family:monospace;"></textarea>'
        + '</div>'
        + '<div style="margin-top:6px;display:flex;gap:6px;">'
        + '<button onclick="runQueryFromPicker(\\'' + cardId + '\\')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;border-color:#4a9fff;color:#4a9fff;">Run Query</button>'
        + '</div>'
        + '</div>';
      cards.push(card);
      renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40);
      cardCounter++;
      updateStatus();
      const pickerEl = document.querySelector('[data-kv-picker="' + cardId + '"]');
      if (pickerEl) {
        pickerEl.addEventListener('change', (e) => {
          if (e.target.classList.contains('kv-check')) {
            e.target.closest('.kv-picker-item')?.classList.toggle('selected', e.target.checked);
          }
          const count = pickerEl.querySelectorAll('.kv-check:checked').length;
          const countEl = document.getElementById('kv-picker-count-' + cardId);
          if (countEl) countEl.textContent = count + ' selected';
        });
        const searchEl = pickerEl.querySelector('[data-kv-search="' + cardId + '"]');
        if (searchEl) {
          searchEl.addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            pickerEl.querySelectorAll('.kv-picker-item').forEach(item => {
              const key = item.querySelector('.kv-key')?.textContent?.toLowerCase() || '';
              const preview = item.querySelector('.kv-preview')?.textContent?.toLowerCase() || '';
              item.style.display = (!q || key.includes(q) || preview.includes(q)) ? '' : 'none';
            });
            pickerEl.querySelectorAll('.kv-picker-group').forEach(group => {
              const visible = group.querySelectorAll('.kv-picker-item:not([style*="display: none"])').length;
              group.style.display = visible > 0 ? '' : 'none';
              if (q && visible > 0) {
                const header = group.querySelector('.kv-picker-group-header');
                if (header) header.classList.remove('collapsed');
              }
            });
          });
        }
      }
    }

    function kvPickerSelectAll(cardId) {
      const picker = document.querySelector('[data-kv-picker="' + cardId + '"]');
      if (!picker) return;
      picker.querySelectorAll('.kv-picker-item').forEach(item => {
        if (item.style.display !== 'none') {
          const cb = item.querySelector('.kv-check');
          if (cb) { cb.checked = true; item.classList.add('selected'); }
        }
      });
      const count = picker.querySelectorAll('.kv-check:checked').length;
      const countEl = document.getElementById('kv-picker-count-' + cardId);
      if (countEl) countEl.textContent = count + ' selected';
    }

    function kvPickerSelectNone(cardId) {
      const picker = document.querySelector('[data-kv-picker="' + cardId + '"]');
      if (!picker) return;
      picker.querySelectorAll('.kv-check').forEach(cb => { cb.checked = false; });
      picker.querySelectorAll('.kv-picker-item').forEach(item => { item.classList.remove('selected'); });
      const countEl = document.getElementById('kv-picker-count-' + cardId);
      if (countEl) countEl.textContent = '0 selected';
    }

    async function runQuery(queryText, domains) {
      showSpinner('Querying...');
      try {
        const res = await fetch(API('/query'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: queryText, domains: domains || ['general'], scope: 'all' }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.queryId) {
          if (data.card && !cards.find(c => c.id === data.card.id)) {
            cards.push(data.card); renderCard(data.card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus();
          }
          showToast('Query complete: ' + (data.results?.length || 0) + ' results, ' + Math.round((data.coverageScore || 0) * 100) + '% coverage', 'success');
        } else {
          showToast('Query failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) { hideSpinner(); showToast('Query error: ' + e.message, 'error'); }
    }

    async function runQueryFromPicker(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const input = document.getElementById('kv-query-input-' + cardId);
      const queryText = input ? input.value.trim() : '';
      if (!queryText) { showToast('Enter a query', 'warning'); return; }
      const picker = document.querySelector('[data-kv-picker="' + cardId + '"]');
      const selectedEntries = [];
      if (picker) {
        picker.querySelectorAll('.kv-check:checked').forEach(cb => {
          const ns = cb.dataset.ns;
          const key = cb.dataset.key;
          const id = cb.dataset.id;
          const entry = card.kvPickerEntries?.find(e => e.id === id);
          if (entry) selectedEntries.push(entry);
        });
      }
      showSpinner('Querying...');
      try {
        const res = await fetch(API('/query'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: queryText, domains: card.domains || ['general'], scope: 'all', kvEntries: selectedEntries }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.queryId) {
          card.queryText = queryText;
          card.content = queryText;
          card.queryId = data.queryId;
          card.results = data.results || [];
          card.coverageScore = data.coverageScore || 0;
          card.principlesApplied = data.principlesApplied || [];
          card.kvSelectedEntries = selectedEntries;
          card._pickerHtml = null;
          card.title = '🔎 ' + queryText.slice(0, 50);
          const el = document.getElementById('card-' + cardId);
          if (el) { el.remove(); renderCard(card, card.x || 100, card.y || 100); }
          showToast('Query complete: ' + (data.results?.length || 0) + ' results', 'success');
        } else {
          showToast('Query failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) {
        hideSpinner();
        showToast('Query error: ' + e.message, 'error');
      }
    }

    function materializeQueryResult(queryCardId, resultIndex) {
      const card = cards.find(c => c.id === queryCardId);
      if (!card || !card.results || !card.results[resultIndex]) return;
      const result = card.results[resultIndex];
      if (result.sourceType === 'card') {
        const source = cards.find(c => c.id === result.sourceId);
        if (source) {
          toggleSelect(source.id);
          showToast('Selected source card: ' + source.title, 'success');
        }
      } else {
        showToast('Result: ' + (result.snippet || '').slice(0, 80), 'success');
      }
    }

    async function rerunQuery(queryCardId) {
      const card = cards.find(c => c.id === queryCardId);
      if (!card) return;
      await updateCard(queryCardId, { content: card.queryText || card.content });
      await runQuery(card.queryText || card.content, card.domains);
    }

    // ── Truth-Audit ──
    function watchKey() {
      let key = sessionStorage.getItem('tew_admin_key') || '';
      if (!key) {
        key = window.prompt('ADMIN_KEY for the watchtower');
        if (key) sessionStorage.setItem('tew_admin_key', key);
      }
      return key || '';
    }
    // Every section folds, and every section copies as one block, so the panel can be
    // handed to another agent without transcribing it by hand.
    function wtCollapsed() {
      // Open quiet: the tools list starts folded and everything else open, until you
      // toggle something. localStorage is per browser, so each device keeps its own.
      try {
        const raw = localStorage.getItem('tew_wt_collapsed');
        if (!raw) return { tools: true };
        return JSON.parse(raw) || {};
      } catch (e) { return { tools: true }; }
    }
    function wtSaveCollapsed(state) {
      try { localStorage.setItem('tew_wt_collapsed', JSON.stringify(state)); } catch (e) {}
    }
    function wtApplyCollapse() {
      const state = wtCollapsed();
      document.querySelectorAll('[data-wt-body]').forEach(function (body) {
        const key = body.getAttribute('data-wt-body');
        const hidden = !!state[key];
        body.style.display = hidden ? 'none' : 'block';
        const caret = document.querySelector('[data-wt-caret="' + key + '"]');
        if (caret) caret.textContent = hidden ? '\\u25b8' : '\\u25be';
      });
    }
    function wtToggleSection(key) {
      const state = wtCollapsed();
      state[key] = !state[key];
      wtSaveCollapsed(state);
      wtApplyCollapse();
    }
    function wtCopySection(key) {
      const body = document.querySelector('[data-wt-body="' + key + '"]');
      if (!body) return;
      const titleEl = document.querySelector('[data-wt-toggle="' + key + '"]');
      const title = titleEl ? titleEl.textContent.replace(/^[\\s\\u25b8\\u25be]+/, '').trim() : key;
      const text = '# Watchtower \\u2014 ' + title + '\\n\\n' + (body.innerText || '').trim();
      const ok = function () { showToast('copied ' + key, 'success'); };
      const bad = function () { showToast('copy failed', 'warning'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, bad);
      else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy') ? ok() : bad(); } catch (e) { bad(); }
        ta.remove();
      }
    }
    function wtSect(key, title, actionsHtml, bodyHtml) {
      return '<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px" data-wt-sect="' + key + '">' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between;align-items:center">' +
          '<button data-wt-toggle="' + key + '" style="background:none;border:0;padding:0;cursor:pointer;color:var(--accent);font-size:12px;font-family:var(--mono);text-align:left"><span data-wt-caret="' + key + '">\\u25be</span> ' + title + '</button>' +
          '<span style="display:flex;flex-wrap:wrap;gap:4px">' + (actionsHtml || '') +
            '<button class="ctrl-btn" data-wt-copy="' + key + '" style="height:22px;font-size:10px;padding:0 6px">copy</button>' +
          '</span>' +
        '</div>' +
        '<div data-wt-body="' + key + '" style="margin-top:4px">' + bodyHtml + '</div>' +
      '</div>';
    }
    function watchPanel() {
      let el = document.getElementById('watchtower');
      if (el) return el;
      el = document.createElement('div');
      el.id = 'watchtower';
      el.style.cssText = 'position:fixed;top:52px;right:0;bottom:0;width:min(480px,92vw);overflow:auto;background:var(--panel);border-left:1px solid var(--border);padding:14px;z-index:var(--z-panel);font-family:var(--mono);font-size:12px;line-height:1.65;color:var(--text);display:none';

      el.innerHTML =
        wtSect('tools', 'Watchtower',
          '<button class="ctrl-btn" id="watchAdd" style="height:22px;font-size:10px;padding:0 6px">+ tool</button> ' +
          '<button class="ctrl-btn" id="watchRefresh" style="height:22px;font-size:10px;padding:0 6px">refresh</button> ' +
          '<button class="ctrl-btn" id="watchClose" style="height:22px;font-size:10px;padding:0 6px">close</button>',
          '<div id="watchRows" style="color:#8fa6bd">not checked yet</div>') +
        wtSect('learned', 'What it learned',
          '<button class="ctrl-btn" id="learnAdd" style="height:22px;font-size:10px;padding:0 6px">+ row</button> ' +
          '<button class="ctrl-btn" id="learnForget" style="height:22px;font-size:10px;padding:0 6px">forget all</button> ' +
          '<button class="ctrl-btn" id="learnSeed" style="height:22px;font-size:10px;padding:0 6px">seed cods</button>',
          '<div id="learnRows" style="color:var(--muted)">not loaded</div>') +
        wtSect('deciders', 'Deciders',
          '<button class="ctrl-btn" id="decideProbe" style="height:22px;font-size:10px;padding:0 6px">probe</button> ' +
          '<button class="ctrl-btn" id="decideJson" style="height:22px;font-size:10px;padding:0 6px">json</button>',
          '<div style="display:flex;gap:4px;margin-top:2px"><input id="decideText" placeholder="the ask to compare on" style="flex:1;min-width:0;height:24px;font-size:11px;background:var(--canvas);border:1px solid var(--border);color:var(--text);padding:0 6px;border-radius:3px"><button class="ctrl-btn" id="decideGo" style="height:24px;font-size:10px;padding:0 8px">run</button></div><div id="decideRows" style="color:var(--muted);margin-top:6px">not loaded</div><div id="decideFoot" style="font-size:10px;color:var(--dim);margin-top:4px"></div><div id="decideTraffic" style="margin-top:8px"></div>') +
        wtSect('keys', 'Keys',
          '<button class="ctrl-btn" id="keysCheck" style="height:22px;font-size:10px;padding:0 6px">check</button>',
          '<div id="keysRows" style="color:var(--muted)">not checked</div><div id="keysTldr"></div>');

      document.body.appendChild(el);
      el.querySelector('#watchClose').onclick = function () { el.style.display = 'none'; };
      el.querySelector('#watchRefresh').onclick = function () { refreshWatchtower(); };
      el.querySelector('#watchAdd').onclick = function () { addWatchTool(); };
      el.querySelector('#learnAdd').onclick = function () { addLearnRow(); };
      el.querySelector('#learnForget').onclick = function () { learnForget(); };
      el.querySelector('#learnSeed').onclick = function () { learnSeed(); };
      el.querySelector('#decideProbe').onclick = function () { probeDeciders(); };
      el.querySelector('#decideJson').onclick = function () { wtCopyDecidersJson(); };
      el.querySelector('#decideGo').onclick = function () { probeDeciders(); };
      el.querySelector('#keysCheck').onclick = function () { loadKeys(); };
      el.addEventListener('click', function (e) {
        const toggle = e.target.closest ? e.target.closest('[data-wt-toggle]') : null;
        if (toggle) { wtToggleSection(toggle.getAttribute('data-wt-toggle')); return; }
        const copy = e.target.closest ? e.target.closest('[data-wt-copy]') : null;
        if (copy) wtCopySection(copy.getAttribute('data-wt-copy'));
      });
      wtApplyCollapse();
      return el;
    }

    async function openWatchtower() {
      watchPanel().style.display = 'block';
      await refreshWatchtower();
    }
    async function refreshWatchtower() {
      const rows = watchPanel().querySelector('#watchRows');
      const key = watchKey();
      if (!key) return;
      rows.textContent = 'checking every tool...';
      try {
        const res = await fetch(API('/watch'), { headers: { 'x-admin-key': key } });
        const d = await res.json();
        if (!res.ok) {
          if (res.status === 401 || res.status === 503) sessionStorage.removeItem('tew_admin_key');
          rows.textContent = d.message || d.error || 'watch failed';
          return;
        }
        rows.innerHTML = '';
        const tools = d.tools || [];
        tools.forEach(function (t) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;padding:4px 0;border-bottom:1px solid #16202e';
          const dot = document.createElement('span');
          dot.textContent = t.ok ? '\u25cf' : '\u25cb';
          dot.style.color = t.ok ? 'var(--ok)' : 'var(--bad)';
          const name = document.createElement('span');
          name.textContent = t.name;
          name.style.cssText = 'width:56px;color:#e6f2ff';
          const meta = document.createElement('span');
          meta.textContent = (t.status || 0) + ' \u00b7 ' + (t.ms == null ? '-' : t.ms + 'ms') + (t.detail ? ' \u00b7 ' + t.detail : '');
          meta.style.cssText = 'flex:1;color:#8fa6bd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          meta.title = (t.base || '') + (t.path || '');
          row.appendChild(dot); row.appendChild(name); row.appendChild(meta);
          rows.appendChild(row);
        });
        const foot = document.createElement('div');
        foot.style.cssText = 'margin-top:8px;color:#5b7288';
        const up = tools.filter(function (t) { return t.ok; }).length;
        foot.textContent = 'checked ' + (d.at || '') + ' \u00b7 ' + up + ' of ' + tools.length + ' answering';
        rows.appendChild(foot);
      } catch (e) {
        rows.textContent = 'watch error: ' + e.message;
      }
      loadLearned();
      loadDecided();
      loadKeys();
    }
    // Which service holds which secret, and whether the keys this Worker holds
    // still open the gates they are for. The map is static; only the checks move.
    async function confirmKeysMap() {
      const key = watchKey();
      if (!key) return;
      try {
        const res = await fetch(API('/keys'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify({ action: 'confirm' })
        });
        if (res.ok) { showToast('map confirmed', 'success'); loadKeys(); }
        else showToast('confirm failed', 'warning');
      } catch (e) {
        showToast('confirm failed: ' + e.message, 'warning');
      }
    }
    async function loadKeys() {
      const box = document.getElementById('keysRows');
      if (!box) return;
      const key = watchKey();
      if (!key) return;
      box.textContent = 'checking keys...';
      try {
        const res = await fetch(API('/keys'), { headers: { 'x-admin-key': key } });
        const d = await res.json();
        if (!res.ok) { box.textContent = d.message || d.error || 'keys failed'; return; }
        renderKeys(d);
      } catch (e) {
        box.textContent = 'keys error: ' + e.message;
      }
    }
    function keysLine(text, color, size) {
      const line = document.createElement('div');
      line.style.cssText = 'margin-top:' + (size === 'tag' ? '6px' : '3px') + ';font-size:' + (size === 'tag' ? '9px' : '11px') + ';color:' + color + (size === 'tag' ? ';letter-spacing:.08em;text-transform:uppercase' : '');
      line.textContent = text;
      return line;
    }
    function keysCmd(text) {
      const line = document.createElement('div');
      line.style.cssText = 'margin-top:4px;padding:5px 6px;background:var(--canvas);border:1px solid var(--border);border-radius:3px;font-family:var(--mono);font-size:10px;line-height:1.5;color:#c9dced;word-break:break-all;cursor:pointer';
      line.textContent = text;
      line.title = 'click to copy';
      line.onclick = function () {
        const done = function () { showToast('copied', 'success'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
        else done();
      };
      return line;
    }
    function keysPlan(d) {
      const box = document.getElementById('keysRows');
      if (!box) return;
      (d.plan || []).forEach(function (g) {
        const head = document.createElement('div');
        head.style.cssText = 'margin-top:14px;padding:6px 8px;background:var(--canvas);border-left:2px solid var(--accent);font-size:12px;font-weight:600;color:var(--text)';
        head.textContent = g.title;
        box.appendChild(head);
        if (g.sub) box.appendChild(keysLine(g.sub, 'var(--muted)'));
        (g.rows || []).forEach(function (r) {
          const row = document.createElement('div');
          row.style.cssText = 'padding:3px 0 3px 8px;font-size:11px;color:#e6f2ff';
          const k = document.createElement('span');
          k.style.cssText = 'font-family:var(--mono);color:#8fd0ff';
          k.textContent = r.k;
          const where = document.createElement('span');
          where.style.cssText = 'color:#8fa6bd';
          where.textContent = '  ' + r.where;
          row.appendChild(k); row.appendChild(where);
          box.appendChild(row);
          if (r.cmd) box.appendChild(keysCmd(r.cmd));
        });
        if (g.cmd) box.appendChild(keysCmd(g.cmd));
      });
    }
    function renderKeys(d) {
      const box = document.getElementById('keysRows');
      if (!box) return;
      box.innerHTML = '';

      const map = d.map || null;
      if (map) {
        const banner = document.createElement('div');
        const stale = !!map.stale;
        banner.style.cssText = 'padding:6px 8px;border-radius:3px;font-size:11px;line-height:1.5;margin-bottom:6px;background:' + (stale ? 'rgba(255,74,74,.14)' : 'rgba(74,184,255,.08)') + ';border:1px solid ' + (stale ? 'var(--bad)' : 'var(--border)') + ';color:' + (stale ? '#ff9c9c' : '#8fa6bd');
        banner.textContent = (stale ? 'STALE MAP \u2014 ' : 'map ') +
          (map.confirmedAt ? 'confirmed ' + map.ageDays + ' day' + (map.ageDays === 1 ? '' : 's') + ' ago' : 'never confirmed, dated ' + (map.at || '?')) +
          (stale ? '. Run wrangler secret list, then confirm.' : ' \u00b7 ' + (map.at || ''));
        box.appendChild(banner);
        const confirm = document.createElement('button');
        confirm.className = 'ctrl-btn';
        confirm.style.cssText = 'height:22px;font-size:10px;padding:0 6px;margin-bottom:6px';
        confirm.textContent = 'confirm map';
        confirm.onclick = function () { confirmKeysMap(); };
        box.appendChild(confirm);
        if ((map.drift || []).length) {
          box.appendChild(keysLine('drift \u2014 the map and reality disagree', '#ff9c9c'));
          map.drift.forEach(function (row) { box.appendChild(keysLine(row.what + ' \u2014 ' + row.why, '#ff9c9c')); });
        } else {
          box.appendChild(keysLine('no drift between the map and what this Worker can see', '#5b7288'));
        }
        if (map.blind) box.appendChild(keysLine(map.blind, '#5b7288'));
      }

      (d.checks || []).forEach(function (c) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;padding:4px 0;border-bottom:1px solid #16202e';
        const dot = document.createElement('span');
        dot.textContent = c.ok ? '\u25cf' : '\u25cb';
        dot.style.color = c.ok ? 'var(--ok)' : 'var(--bad)';
        const name = document.createElement('span');
        name.textContent = c.key;
        name.style.cssText = 'width:76px;color:#e6f2ff;overflow:hidden;text-overflow:ellipsis';
        const meta = document.createElement('span');
        meta.textContent = (c.held ? (c.status || '—') + ' \u00b7 ' + (c.ms == null ? '-' : c.ms + 'ms') + ' \u00b7 ' : '') + (c.detail || c.label);
        meta.style.cssText = 'flex:1;color:#8fa6bd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        meta.title = c.label + ' \u2014 ' + (c.detail || '');
        row.appendChild(dot); row.appendChild(name); row.appendChild(meta);
        box.appendChild(row);
      });

      if (d.spend) box.appendChild(keysLine('openrouter on tew: ' + (d.spend.openrouter_on_tew ? 'yes' : 'no \u2014 via ORPROXY'), d.spend.openrouter_on_tew ? 'var(--ok)' : 'var(--warn, #e0a83a)'));

      if ((d.pairs || []).length) {
        box.appendChild(keysLine('must match', 'var(--muted)', 'tag'));
        d.pairs.forEach(function (p) { box.appendChild(keysLine(p.need + ' \u2014 ' + p.why, '#8fa6bd')); });
      }
      if ((d.orphans || []).length) {
        box.appendChild(keysLine('no reader', 'var(--muted)', 'tag'));
        d.orphans.forEach(function (o) { box.appendChild(keysLine(o.service + ': ' + o.names.join(', ') + ' \u2014 ' + o.why, '#8fa6bd')); });
      }
      if ((d.misnamed || []).length) {
        box.appendChild(keysLine('misnamed', 'var(--muted)', 'tag'));
        d.misnamed.forEach(function (m) { box.appendChild(keysLine(m.service + ': ' + m.name + ' \u2014 ' + m.why, '#8fa6bd')); });
      }
      if ((d.services || []).length) {
        box.appendChild(keysLine('held', 'var(--muted)', 'tag'));
        d.services.forEach(function (s) { box.appendChild(keysLine(s.service + ' \u2014 ' + s.secrets.join(', '), '#5b7288')); });
      }

      keysPlan(d);

      // The bottom line, for the days the detail is too much.
      const tldrBox = document.getElementById('keysTldr');
      if (tldrBox) {
        tldrBox.innerHTML = '';
        if ((d.tldr || []).length) {
          const box = document.createElement('div');
          box.style.cssText = 'margin-top:12px;padding:8px 10px;border:1px solid var(--border);border-left:2px solid var(--accent);border-radius:3px;background:var(--canvas)';
          const head = document.createElement('div');
          head.style.cssText = 'font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px';
          head.textContent = 'actionable intelligence';
          box.appendChild(head);
          d.tldr.forEach(function (line) {
            const row = document.createElement('div');
            row.style.cssText = 'font-size:11px;color:#c9dced;margin-top:2px';
            row.textContent = '\\u2022 ' + line;
            box.appendChild(row);
          });
          tldrBox.appendChild(box);
        }
      }
      if (d.at) box.appendChild(keysLine('checked ' + d.at, '#5b7288'));
    }
    async function loadLearned() {
      const box = document.getElementById('learnRows');
      if (!box) return;
      const key = watchKey();
      if (!key) return;
      box.textContent = 'reading...';
      try {
        const res = await fetch(API('/learn'), { headers: { 'x-admin-key': key } });
        const d = await res.json();
        if (!res.ok) { box.textContent = d.message || d.error || 'learn failed'; return; }
        renderLearn(d);
      } catch (e) {
        box.textContent = 'learn error: ' + e.message;
      }
    }
    function learnTag(r) {
      const bits = [r.tier || 'learned', r.status || 'active'];
      if (r.fit !== null && r.fit !== undefined) bits.push('fit ' + r.fit);
      if (r.hits) bits.push('used ' + r.hits);
      if (r.earned) bits.push('earned');
      if (r.tool) bits.push(r.tool);
      return bits.join(' \u00b7 ');
    }
    function renderLearn(d) {
      const box = document.getElementById('learnRows');
      if (!box) return;
      box.innerHTML = '';
      const rows = d.rows || [];
      if (!rows.length) {
        box.textContent = 'Nothing yet. A tool reports here when it learns something, or add a row.';
        return;
      }
      rows.forEach(function (r) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:7px 0;border-bottom:1px solid var(--border)';
        const tag = document.createElement('div');
        tag.style.cssText = 'font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)';
        tag.textContent = learnTag(r);
        const q = document.createElement('div');
        q.style.cssText = 'font-size:11px;color:var(--text);margin-top:2px';
        q.textContent = r.q || '';
        const a = document.createElement('div');
        a.style.cssText = 'font-size:11px;color:var(--muted);line-height:1.45';
        a.textContent = r.a || '';
        const ctl = document.createElement('div');
        ctl.style.cssText = 'display:flex;gap:4px;margin-top:4px';
        const flip = document.createElement('button');
        flip.className = 'ctrl-btn';
        flip.style.cssText = 'height:20px;font-size:10px;padding:0 6px';
        flip.textContent = r.status === 'candidate' ? 'Keep' : 'Hold';
        flip.onclick = function () { learnAction(r.status === 'candidate' ? 'keep' : 'hold', r); };
        const del = document.createElement('button');
        del.className = 'ctrl-btn';
        del.style.cssText = 'height:20px;font-size:10px;padding:0 6px';
        del.textContent = 'Remove';
        del.onclick = function () { learnAction('remove', r); };
        ctl.appendChild(flip);
        ctl.appendChild(del);
        row.appendChild(tag);
        row.appendChild(q);
        row.appendChild(a);
        row.appendChild(ctl);
        box.appendChild(row);
      });
      const foot = document.createElement('div');
      foot.style.cssText = 'margin-top:6px;font-size:10px;color:var(--dim)';
      const c = d.counts || {};
      foot.textContent = (c.active || 0) + ' active \u00b7 ' + (c.candidate || 0) + ' candidates \u00b7 ' + (c.rules || 0) + ' domains' + (d.at ? ' \u00b7 ' + d.at : '');
      box.appendChild(foot);
    }
    async function learnPost(body) {
      const key = watchKey();
      if (!key) return null;
      const res = await fetch(API('/learn'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
        body: JSON.stringify(body)
      });
      const d = await res.json().catch(function () { return {}; });
      if (!res.ok) { showToast(d.message || d.error || 'learn failed', 'error'); return null; }
      return d;
    }
    async function learnAction(act, r) {
      const d = await learnPost({ action: act, q: r.q });
      if (!d) return;
      if (act === 'remove') showToast('Removed', 'success');
      else if (act === 'keep') showToast('Kept as active', 'success');
      else showToast('Held as candidate', 'success');
      loadLearned();
    }
    async function addLearnRow() {
      const q = window.prompt('What should it know about you?');
      if (!q) return;
      const a = window.prompt('And what to do about it?');
      if (!a) return;
      const d = await learnPost({ action: 'add', q: q, a: a, source: 'him', tool: 'tew' });
      if (d) { showToast('Added', 'success'); loadLearned(); }
    }
    async function learnForget() {
      if (!window.confirm('Forget everything the ledger holds? Domains go too.')) return;
      const d = await learnPost({ action: 'forget' });
      if (d) { showToast('Forgotten: ' + d.forgot + ' rows', 'success'); loadLearned(); }
    }
    async function learnSeed() {
      const d = await learnPost({ action: 'seed' });
      if (!d) return;
      showToast('Seeded ' + (d.seeded || 0) + ' rows from cods', 'success');
      loadLearned();
    }
    async function loadDecided() {
      const box = document.getElementById('decideRows');
      if (!box) return;
      const key = watchKey();
      if (!key) return;
      box.textContent = 'reading...';
      try {
        const res = await fetch(API('/decide'), { headers: { 'x-admin-key': key } });
        const d = await res.json();
        if (!res.ok) { box.textContent = d.message || d.error || 'deciders failed'; return; }
        renderDecided(d);
      } catch (e) {
        box.textContent = 'deciders error: ' + e.message;
      }
    }
    function decideCost(n) {
      if (n === null || n === undefined) return '-';
      return '$' + ((n * 1000000).toFixed(2)) + '/M';
    }
    function renderTraffic(t) {
      const box = document.getElementById('decideTraffic');
      if (!box) return;
      box.innerHTML = '';
      if (!t) return;
      if (!t.ok) { box.textContent = 'recorded traffic unavailable: ' + (t.error || 'unknown'); return; }
      const head = document.createElement('div');
      head.style.cssText = 'font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px';
      head.textContent = 'Recorded · last ' + (t.total || 0) + ' decisions in ARA';
      box.appendChild(head);
      (t.models || []).forEach(function (m) {
        const line = document.createElement('div');
        line.style.cssText = 'font-size:10px;color:var(--muted);line-height:1.5';
        line.textContent = m.model + ' \u00b7 ' + m.n + ' \u00b7 med ' + (m.msMedian == null ? '-' : m.msMedian + 'ms') + ' \u00b7 ' + decideCost(m.cost);
        box.appendChild(line);
      });
      if (!(t.models || []).length) box.appendChild(document.createTextNode('no rows yet'));
    }
    function renderDecideBudget(b) {
      const foot = document.getElementById('decideFoot');
      if (!foot) return;
      foot.textContent = b ? ('probes this hour: ' + (b.used || 0) + ' of ' + (b.limit || 0) + ' \u00b7 ' + (b.hour || '') + ':00Z') : '';
    }
    function renderDecided(d) {
      lastDecide = d;
      const box = document.getElementById('decideRows');
      if (!box) return;
      box.innerHTML = '';
      const adopted = d.adopted || null;
      const results = d.results || null;
      if (!results) {
        box.textContent = adopted
          ? ('adopted: ' + adopted.model + ' \u00b7 ' + (adopted.at || ''))
          : 'Nothing adopted. Type an ask and probe to compare them.';
        renderDecideBudget(d.budget);
        renderTraffic(d.traffic);
        return;
      }
      results.forEach(function (r) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:7px 0;border-bottom:1px solid var(--border)';
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;gap:6px;align-items:baseline;justify-content:space-between';
        const name = document.createElement('span');
        name.textContent = r.label + ' \u00b7 ' + r.model;
        name.style.cssText = 'font-size:10px;color:var(--text)';
        const ms = document.createElement('span');
        ms.textContent = r.ok ? (r.ms + 'ms') : 'failed';
        ms.style.cssText = 'font-size:10px;color:' + (r.ok ? 'var(--ok)' : 'var(--bad)');
        head.appendChild(name);
        head.appendChild(ms);
        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:10px;color:var(--muted);margin-top:2px;line-height:1.45';
        if (r.ok) {
          const via = r.via ? ' \u00b7 ' + r.via : '';
          const spread = r.spread ? ' \u00b7 ' + r.spread.map(function (s) { return s.option + ':' + s.p; }).join(' ') : '';
          meta.textContent = r.choice + (r.route ? ' / ' + r.route : '') + ' \u00b7 conf ' + r.confidence + ' \u00b7 ' + decideCost(r.cost) + via + spread;
        } else {
          meta.textContent = r.error || 'no answer';
        }
        const ctl = document.createElement('div');
        ctl.style.cssText = 'display:flex;gap:4px;margin-top:4px;align-items:center';
        const isAdopted = !!(adopted && adopted.model === r.model);
        const pick = document.createElement('button');
        pick.className = 'ctrl-btn';
        pick.style.cssText = 'height:20px;font-size:10px;padding:0 6px';
        pick.textContent = isAdopted ? 'adopted' : 'adopt';
        pick.disabled = isAdopted;
        pick.onclick = function () { adoptDecider(r.model); };
        ctl.appendChild(pick);
        if (isAdopted) {
          const on = document.createElement('span');
          on.textContent = 'in use here';
          on.style.cssText = 'font-size:9px;color:var(--ok)';
          ctl.appendChild(on);
        }
        row.appendChild(head);
        row.appendChild(meta);
        row.appendChild(ctl);
        box.appendChild(row);
      });
      if (d.ladder) {
        const l = d.ladder;
        const row = document.createElement('div');
        row.style.cssText = 'padding:7px 0;border-top:1px solid var(--border);color:var(--muted)';
        row.textContent = l.model + ' \u00b7 ' + (l.ok ? (l.ms + 'ms \u00b7 ' + l.choice + (l.route ? ' / ' + l.route : '') + ' \u00b7 conf ' + l.confidence + ' \u00b7 ' + decideCost(l.cost) + (l.served ? ' \u00b7 served ' + l.served : '')) : (l.error || 'no answer'));
        box.appendChild(row);
      }
      renderDecideBudget(d.budget);
      renderTraffic(d.traffic);
    }
    // The probe results as data, for another agent or a spreadsheet. Renders from the
    // same payload the rows come from; if nothing has been probed this session it asks
    // for the current state first rather than exporting an empty object.
    let lastDecide = null;
    async function wtCopyDecidersJson() {
      const copy = function (text) {
        const ok = function () { showToast('decider JSON copied', 'success'); };
        const bad = function () { showToast('copy failed', 'warning'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, bad);
        else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy') ? ok() : bad(); } catch (e) { bad(); }
          ta.remove();
        }
      };
      if (!lastDecide) {
        const key = watchKey();
        if (!key) return;
        try {
          const res = await fetch(API('/decide'), { headers: { 'x-admin-key': key } });
          if (!res.ok) { showToast('nothing to export yet', 'warning'); return; }
          lastDecide = await res.json();
        } catch (e) {
          showToast('export failed: ' + e.message, 'warning');
          return;
        }
      }
      copy(JSON.stringify(lastDecide, null, 2));
    }
    async function probeDeciders() {
      const input = document.getElementById('decideText');
      const ask = input ? input.value.trim() : '';
      if (!ask) { showToast('Type the ask to compare on', 'error'); return; }
      const key = watchKey();
      if (!key) return;
      const box = document.getElementById('decideRows');
      if (box) box.textContent = 'asking every decider...';
      try {
        const res = await fetch(API('/decide'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify({ action: 'probe', ask: ask })
        });
        const d = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          if (box) box.textContent = d.message || d.error || 'probe failed';
          renderDecideBudget(d.budget);
          return;
        }
        renderDecided(d);
        const fast = (d.results || []).filter(function (r) { return r.ok; }).sort(function (a, b) { return a.ms - b.ms; })[0];
        if (fast) showToast('Fastest: ' + fast.label + ' at ' + fast.ms + 'ms', 'success');
      } catch (e) {
        if (box) box.textContent = 'probe error: ' + e.message;
      }
    }
    async function adoptDecider(model) {
      const key = watchKey();
      if (!key) return;
      const res = await fetch(API('/decide'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
        body: JSON.stringify({ action: 'adopt', model: model })
      });
      const d = await res.json().catch(function () { return {}; });
      if (!res.ok) { showToast(d.message || d.error || 'adopt failed', 'error'); return; }
      showToast('Adopted ' + model, 'success');
      loadDecided();
    }

    async function addWatchTool() {
      const name = window.prompt('tool name');
      if (!name) return;
      const base = window.prompt('tool base url, e.g. https://mind.ai-n.workers.dev');
      if (!base) return;
      const path = window.prompt('health path', '/health') || '/health';
      const key = watchKey();
      if (!key) return;
      try {
        const listRes = await fetch(API('/watch'), { headers: { 'x-admin-key': key } });
        const listDoc = await listRes.json();
        const tools = (listDoc.tools || []).map(function (t) { return { name: t.name, base: t.base, path: t.path }; });
        tools.push({ name: name, base: (base.charAt(base.length - 1) === '/' ? base.slice(0, -1) : base), path: path });
        const res = await fetch(API('/watch'), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ tools: tools }) });
        if (!res.ok) { showToast('Could not save: ' + res.status, 'error'); return; }
        showToast('Watching ' + name, 'success');
        await refreshWatchtower();
      } catch (e) {
        showToast('watch error: ' + e.message, 'error');
      }
    }
    function withBusy(btn, fn) {
      if (!btn || btn.classList.contains('is-busy')) return;
      const wasDisabled = btn.disabled;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      Promise.resolve()
        .then(function () { return fn(); })
        .catch(function (e) { showToast(String((e && e.message) || e), 'error'); })
        .then(function () {
          btn.classList.remove('is-busy');
          btn.removeAttribute('aria-busy');
          btn.disabled = wasDisabled;
        });
    }
    async function promptCompare() {
      const ask = window.prompt('Compare which ask? (cods vs mind)');
      if (!ask) return;
      let key = sessionStorage.getItem('tew_admin_key') || '';
      if (!key) {
        key = window.prompt('ADMIN_KEY for /api/compare');
        if (!key) return;
        sessionStorage.setItem('tew_admin_key', key);
      }
      showSpinner('Comparing both...');
      try {
        const res = await fetch(API('/compare'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify({ ask: ask })
        });
        const d = await res.json();
        hideSpinner();
        if (!res.ok) {
          if (res.status === 401 || res.status === 503) sessionStorage.removeItem('tew_admin_key');
          showToast(d.message || d.error || 'Compare failed', 'error');
          return;
        }
        const line = function (x) {
          if (!x) return 'nothing back';
          if (x.error) return 'error: ' + x.error;
          return [x.route || 'route ?', x.cacheSource ? 'from ' + x.cacheSource : 'generated',
            x.move ? 'move ' + x.move : '', x.clarify ? 'asks a question' : '', x.chars + ' chars']
            .filter(Boolean).join(' · ');
        };
        const text = ['ask          ' + d.ask, 'mind         ' + line(d.mind), 'cods         ' + line(d.cods),
          'verdict      ' + d.verdict, 'teach        '].join(String.fromCharCode(10));
        await createCard('Compare', d.ask, text);
        showToast('Compared: ' + d.verdict, 'success');
      } catch (e) {
        hideSpinner();
        showToast('Compare error: ' + e.message, 'error');
      }
    }
    function promptAudit() {
      promptAuditWithKVPicker();
    }
    async function promptAuditWithKVPicker() {
      showSpinner('Loading KV entries...');
      let entries = [];
      try {
        const res = await fetch(API('/kv/all'));
        const data = await res.json();
        entries = data.entries || [];
      } catch (e) {
        hideSpinner();
        showToast('Failed to load KV entries: ' + e.message, 'error');
        return;
      }
      hideSpinner();
      const cardId = 'card_' + crypto.randomUUID();
      const grouped = {};
      for (const e of entries) {
        if (!grouped[e.ns]) grouped[e.ns] = [];
        grouped[e.ns].push(e);
      }
      let listHtml = '<input class="kv-picker-search" type="text" placeholder="Filter entries..." data-kv-search="' + cardId + '" />';
      for (const [ns, items] of Object.entries(grouped)) {
        const nsShort = ns.replace('_KV','').replace('KV_','');
        const grpId = cardId + '_' + ns;
        listHtml += '<div class="kv-picker-group" data-kv-group="' + ns + '" data-kv-group-card="' + cardId + '">'
          + '<div class="kv-picker-group-header" style="cursor:pointer;" onclick="const el=document.getElementById(\\'gitems-' + grpId + '\\');const arrow=document.getElementById(\\'garrow-' + grpId + '\\');if(el.style.display===\\'none\\'){el.style.display=\\'block\\';arrow.style.transform=\\'rotate(0deg)\\';}else{el.style.display=\\'none\\';arrow.style.transform=\\'rotate(-90deg)\\';}">'
          + '<span id="garrow-' + grpId + '" class="arrow" style="display:inline-block;transform:rotate(-90deg);transition:transform 0.15s;">▼</span> ' + nsShort + ' <span style="color:#666;font-weight:400;">(' + items.length + ')</span>'
          + '</div>'
          + '<div id="gitems-' + grpId + '" class="kv-picker-group-items" style="display:none;">';
        for (const item of items) {
          const preview = typeof item.value === 'object' ? JSON.stringify(item.value).slice(0, 80) : String(item.value).slice(0, 80);
          listHtml += '<label class="kv-picker-item" data-kv-id="' + item.id + '" data-kv-group-card="' + cardId + '">'
            + '<input type="checkbox" class="kv-check" data-ns="' + item.ns + '" data-key="' + item.key + '" data-id="' + item.id + '">'
            + '<div style="flex:1;min-width:0;"><div class="kv-key">' + escapeHtml(item.key) + '</div><div class="kv-preview">' + escapeHtml(preview) + '</div></div>'
            + '</label>';
        }
        listHtml += '</div></div>';
      }
      if (entries.length === 0) listHtml += '<div style="color:#666;font-size:11px;padding:12px;text-align:center;">No KV entries found.</div>';
      const card = {
        id: cardId,
        type: 'Audit',
        title: '🔍 New Audit — Select KV Sources',
        content: '',
        auditScope: 'compliance',
        targetCardIds: [],
        status: null,
        overallConfidence: 0,
        findings: [],
        principleCoverage: null,
        kvPickerEntries: entries,
        splitView: false,
      };
      card._pickerHtml = '<div style="padding:4px 0;">'
        + '<div style="font-size:10px;color:#888;margin-bottom:4px;">Select KV entries to audit against (' + entries.length + ' total)</div>'
        + '<div class="kv-picker-controls">'
        + '<button onclick="kvPickerSelectAll(\\'' + cardId + '\\')" class="ctrl-btn" style="font-size:10px;padding:2px 6px;">Select All</button>'
        + '<button onclick="kvPickerSelectNone(\\'' + cardId + '\\')" class="ctrl-btn" style="font-size:10px;padding:2px 6px;">None</button>'
        + '<span id="kv-picker-count-' + cardId + '" style="font-size:10px;color:#888;margin-left:auto;">0 selected</span>'
        + '</div>'
        + '<div class="kv-picker" data-kv-picker="' + cardId + '">' + listHtml + '</div>'
        + '<div style="margin-top:8px;">'
        + '<select id="kv-audit-scope-' + cardId + '" style="background:#0d0d1a;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:4px 8px;font-size:11px;width:100%;">'
        + '<option value="compliance">Compliance Audit</option>'
        + '<option value="full">Full Audit</option>'
        + '</select>'
        + '</div>'
        + '<div style="margin-top:6px;display:flex;gap:6px;">'
        + '<button onclick="runAuditFromPicker(\\'' + cardId + '\\')" class="ctrl-btn" style="flex:1;font-size:11px;padding:4px 8px;border-color:#ff4a6a;color:#ff4a6a;">Run Audit</button>'
        + '</div>'
        + '</div>';
      cards.push(card);
      renderCard(card, cardCounter * 30 + 40, cardCounter * 30 + 40);
      cardCounter++;
      updateStatus();
      const pickerEl = document.querySelector('[data-kv-picker="' + cardId + '"]');
      if (pickerEl) {
        pickerEl.addEventListener('change', (e) => {
          if (e.target.classList.contains('kv-check')) {
            e.target.closest('.kv-picker-item')?.classList.toggle('selected', e.target.checked);
          }
          const count = pickerEl.querySelectorAll('.kv-check:checked').length;
          const countEl = document.getElementById('kv-picker-count-' + cardId);
          if (countEl) countEl.textContent = count + ' selected';
        });
        const searchEl = pickerEl.querySelector('[data-kv-search="' + cardId + '"]');
        if (searchEl) {
          searchEl.addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            pickerEl.querySelectorAll('.kv-picker-item').forEach(item => {
              const key = item.querySelector('.kv-key')?.textContent?.toLowerCase() || '';
              const preview = item.querySelector('.kv-preview')?.textContent?.toLowerCase() || '';
              item.style.display = (!q || key.includes(q) || preview.includes(q)) ? '' : 'none';
            });
            pickerEl.querySelectorAll('.kv-picker-group').forEach(group => {
              const visible = group.querySelectorAll('.kv-picker-item:not([style*="display: none"])').length;
              group.style.display = visible > 0 ? '' : 'none';
              if (q && visible > 0) {
                const header = group.querySelector('.kv-picker-group-header');
                if (header) header.classList.remove('collapsed');
              }
            });
          });
        }
      }
    }

    async function runAuditFromPicker(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const scopeEl = document.getElementById('kv-audit-scope-' + cardId);
      const auditScope = scopeEl ? scopeEl.value : 'compliance';
      const picker = document.querySelector('[data-kv-picker="' + cardId + '"]');
      const selectedEntries = [];
      if (picker) {
        picker.querySelectorAll('.kv-check:checked').forEach(cb => {
          const id = cb.dataset.id;
          const entry = card.kvPickerEntries?.find(e => e.id === id);
          if (entry) selectedEntries.push(entry);
        });
      }
      if (selectedEntries.length === 0) { showToast('Select at least one KV entry', 'warning'); return; }
      showSpinner('Auditing...');
      try {
        const res = await fetch(API('/audit'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardIds: [], auditScope, includeSnapshots: true, kvEntries: selectedEntries }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.auditId) {
          card.auditId = data.auditId;
          card.auditScope = auditScope;
          card.status = data.status || 'fail';
          card.overallConfidence = data.overallConfidence || 0;
          card.findings = data.findings || [];
          card.principleCoverage = data.principleCoverage || null;
          card.kvSelectedEntries = selectedEntries;
          card._pickerHtml = null;
          card.title = '🔍 Audit — ' + auditScope + ' (' + selectedEntries.length + ' KV entries)';
          const el = document.getElementById('card-' + cardId);
          if (el) { el.remove(); renderCard(card, card.x || 100, card.y || 100); }
          showToast('Audit complete: ' + card.status + ' (' + Math.round((card.overallConfidence || 0) * 100) + '%)', card.status === 'pass' ? 'success' : card.status === 'conditional' ? 'warning' : 'error');
        } else {
          showToast('Audit failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) {
        hideSpinner();
        showToast('Audit error: ' + e.message, 'error');
      }
    }

    async function runAudit(cardIds, auditScope) {
      showSpinner('Auditing...');
      try {
        const res = await fetch(API('/audit'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardIds, auditScope: auditScope || 'compliance', includeSnapshots: true }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.auditId) {
          if (data.card && !cards.find(c => c.id === data.card.id)) {
            cards.push(data.card); renderCard(data.card, cardCounter * 30 + 40, cardCounter * 30 + 40); cardCounter++; updateStatus();
          }
          showToast(\`Audit complete: \${data.status} (\${Math.round((data.overallConfidence || 0) * 100)}%)\`, data.status === 'pass' ? 'success' : data.status === 'conditional' ? 'warning' : 'error');
        } else {
          showToast('Audit failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) { hideSpinner(); showToast('Audit error: ' + e.message, 'error'); }
    }

    async function reAudit(auditCardId) {
      const card = cards.find(c => c.id === auditCardId);
      if (!card) return;
      await runAudit(card.targetCardIds || [], card.auditScope);
    }

    function exportAudit(auditCardId) {
      const card = cards.find(c => c.id === auditCardId);
      if (!card) return;
      const report = {
        auditId: card.auditId,
        status: card.status,
        overallConfidence: card.overallConfidence,
        findings: card.findings,
        principleCoverage: card.principleCoverage,
        domainStack: card.domainStack,
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = \`audit-\${card.auditId}.json\`; a.click();
      URL.revokeObjectURL(url);
      showToast('Audit exported', 'success');
    }

    // ── Tab List (Queries / Audits / EITL) ──
    function openTabList(filterType) {
      const filtered = filterType === 'eitl'
        ? cards.filter(c => c.eitlStatus)
        : cards.filter(c => c.type === filterType);
      const typeLabel = filterType === 'eitl' ? 'EITL Review' : filterType + 's';
      const icon = filterType === 'Query' ? '🔎' : filterType === 'Audit' ? '🔍' : '⚙';
      let listHtml = '';
      if (filtered.length === 0) {
        listHtml = '<div style="color:#666;font-size:12px;padding:16px;text-align:center;">No ' + typeLabel + ' found. Click the button below to create one.</div>';
      } else {
        listHtml = filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(c => {
          const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
          const conf = c.confidence?.total ? Math.round(c.confidence.total * 100) + '%' : c.overallConfidence ? Math.round(c.overallConfidence * 100) + '%' : '';
          const statusBadge = c.eitlStatus ? '<span style="color:' + (c.eitlStatus === 'elevated' ? '#4aff8a' : c.eitlStatus === 'remanded' ? '#ff4a4a' : '#ffaa4a') + ';font-size:10px;margin-left:6px;">' + c.eitlStatus.toUpperCase() + '</span>' : '';
          const statusDot = c.status ? '<span style="color:' + (c.status === 'pass' ? '#4aff8a' : c.status === 'conditional' ? '#ffaa4a' : '#ff4a4a') + ';font-size:10px;margin-left:6px;">' + c.status.toUpperCase() + '</span>' : '';
          return \`<div onclick="openCardById('\${c.id}')" style="padding:8px 12px;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:12px;display:flex;justify-content:space-between;align-items:center;transition:all 0.15s;" onmouseover="this.style.borderColor='#ff6b1a'" onmouseout="this.style.borderColor='#2a2a4a'">\`
            + '<span style="color:#e0e0e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + (c.title || 'Untitled') + statusBadge + statusDot + '</span>'
            + '<span style="color:#666;font-size:10px;flex-shrink:0;margin-left:8px;">' + (conf ? conf + ' ' : '') + date + '</span>'
            + '</div>';
        }).join('');
      }
      const newBtn = filterType === 'Query' ? '<button onclick="promptQuery()" class="ctrl-btn" style="font-size:10px;padding:2px 8px;border-color:#4a9fff;color:#4a9fff;">+ New Query</button>'
        : filterType === 'Audit' ? '<button onclick="promptAudit()" class="ctrl-btn" style="font-size:10px;padding:2px 8px;border-color:#ff4a6a;color:#ff4a6a;">+ New Audit</button>' : '';
      const cardHtml = '<div style="padding:12px;max-height:400px;overflow-y:auto;">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
        + '<span style="font-size:11px;color:#888;">' + filtered.length + ' items</span>'
        + '<div style="display:flex;gap:6px;">'
        + newBtn
        + '<button onclick="syncFromKV()" class="ctrl-btn" style="font-size:10px;padding:2px 8px;">Sync</button>'
        + '</div>'
        + '</div>'
        + listHtml + '</div>';
      const card = {
        type: 'Document',
        title: icon + ' ' + typeLabel,
        content: cardHtml,
        rawHtml: true,
        splitView: false,
        domains: ['general'],
      };
      createCard(card);
    }

    function openCardById(cardId) {
      const el = document.getElementById('card-' + cardId);
      if (el) {
        el.style.boxShadow = '0 0 0 2px #ff6b1a, 0 8px 32px rgba(0,0,0,0.5)';
        setTimeout(() => el.style.boxShadow = '', 800);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.click();
      } else {
        const allCards = document.querySelectorAll('.card-window');
        for (const c of allCards) {
          if (c.dataset.id === cardId) {
            c.style.boxShadow = '0 0 0 2px #ff6b1a, 0 8px 32px rgba(0,0,0,0.5)';
            setTimeout(() => c.style.boxShadow = '', 800);
            c.scrollIntoView({ behavior: 'smooth', block: 'center' });
            c.click();
            break;
          }
        }
      }
    }

    async function syncFromKV() {
      showSpinner('Syncing from orproxy KV...');
      try {
        const res = await fetch(API('/sync'), { method: 'GET' });
        const data = await res.json();
        hideSpinner();
        if (data.synced > 0) {
          showToast('Synced ' + data.synced + ' items from KV', 'success');
          if (data.cards && data.cards.length) {
            data.cards.forEach(c => {
              if (!cards.find(x => x.id === c.id)) {
                cards.push(c);
                renderCard(c, cardCounter * 30 + 40, cardCounter * 30 + 40);
                cardCounter++;
              }
            });
            updateStatus();
          }
        } else {
          showToast('No new items to sync', 'info');
        }
      } catch (e) { hideSpinner(); showToast('Sync error: ' + e.message, 'error'); }
    }

    // ── Domain Browser ──
    function promptDomain() {
      const domain = prompt('Enter domain (general/legal/educational/medical/technical):', 'general');
      if (domain && ['general','legal','educational','medical','technical'].includes(domain)) {
        createDomainBrowser(domain);
      } else if (domain) {
        showToast('Invalid domain', 'error');
      }
    }
    async function createDomainBrowser(domain) {
      try {
        const res = await fetch(\`/api/domains/\${domain}/assets\`);
        const data = await res.json();
        const card = {
          type: 'DomainBrowser',
          title: \`\${domain.charAt(0).toUpperCase() + domain.slice(1)} Domain\`,
          content: '',
          domain,
          view: 'assets',
          assets: data.assets || [],
          principleCount: 0,
          activeStack: null,
          domains: [domain],
        };
        await createCard(card);
      } catch (e) {
        showToast('Failed to load domain: ' + e.message, 'error');
      }
    }

    function switchDomainView(cardId, view) {
      const card = cards.find(c => c.id === cardId);
      if (card) {
        card.view = view;
        updateCardDOM(card);
      }
    }

    async function syncDomainPrinciples(domain) {
      showSpinner('Syncing...');
      try {
        const res = await fetch('/api/domains/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
        const data = await res.json();
        hideSpinner();
        if (data.ok) showToast(\`Synced \${data.synced} principles to \${domain} KV\`, 'success');
        else showToast('Sync failed', 'error');
      } catch (e) { hideSpinner(); showToast('Sync error: ' + e.message, 'error'); }
    }

    function uploadToDomain(cardId, domain) {
      const input = document.createElement('input');
      input.type = 'file';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        showSpinner('Uploading...');
        try {
          const res = await fetch(\`/api/domains/\${domain}/assets\`, {
            method: 'POST',
            body: formData,
          });
          const data = await res.json();
          hideSpinner();
          if (data.ok) {
            showToast(\`Uploaded \${file.name} to \${domain}\`, 'success');
            const card = cards.find(c => c.id === cardId);
            if (card && card.type === 'DomainBrowser') {
              const assetsRes = await fetch(\`/api/domains/\${domain}/assets\`);
              const assetsData = await assetsRes.json();
              card.assets = assetsData.assets || [];
              updateCardDOM(card);
            }
          }
        } catch (e) { hideSpinner(); showToast('Upload error: ' + e.message, 'error'); }
      };
      input.click();
    }

    // ── Domain Stack Panel ──
    async function loadDomains() {
      try {
        const res = await fetch('/api/domains');
        const data = await res.json();
        return data.domains || [];
      } catch { return []; }
    }

    // ── NSM Panel ──
    async function openNSM() {
      const existing = cards.find(c => c.title === '🧠 NSM Domains');
      const card = existing || await createCard({ type: 'Document', title: '🧠 NSM Domains', content: '<div style="color:#666;text-align:center;padding:20px;">Loading NSM domains...</div>', rawHtml: true, width: 520, height: 420 });
      const cardId = card.id;
      if (existing) {
        const host = document.querySelector('[data-rawcontent="' + cardId + '"]');
        if (host) host.innerHTML = '<div style="color:#666;text-align:center;padding:20px;">Refreshing...</div>';
      }
      updateStatus();
      try {
        const res = await fetch('/api/nsm/domains');
        const data = await res.json();
        let html = '';
        if (!data.domains || data.domains.length === 0) {
          html = '<div style="color:#666;text-align:center;padding:30px;">No domains acquired yet.<br><span style="color:#444;font-size:11px;">Domains are created when NSM patterns build enough consensus.</span></div>';
        } else {
          for (const d of data.domains) {
            html += '<div class="nsm-domain" style="background:#0a0a1a;border:1px solid #1a2a4a;border-radius:8px;padding:10px;margin-bottom:8px;">';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
            html += '<span style="color:#4affa0;font-weight:bold;">' + d.name + '</span>';
            html += '<span style="color:#666;font-size:10px;">conf: ' + (d.confidence * 100).toFixed(1) + '% | ' + d.principleCount + ' principles | ' + d.patternCount + ' patterns</span>';
            html += '</div>';
            if (d.principles && d.principles.length > 0) {
              html += '<div style="margin-top:6px;">';
              html += '<div style="color:#888;font-size:10px;margin-bottom:3px;">Domain Principles:</div>';
              for (const p of d.principles.slice(0, 5)) {
                const txt = typeof p === 'string' ? p : p.text || '';
                html += '<div style="color:#aaa;font-size:11px;padding:2px 0;">• ' + txt + '</div>';
              }
              if (d.principles.length > 5) html += '<div style="color:#666;font-size:10px;">+ ' + (d.principles.length - 5) + ' more</div>';
              html += '</div>';
            }
            if (d.patterns && d.patterns.length > 0) {
              html += '<div style="margin-top:4px;">';
              html += '<div style="color:#888;font-size:10px;margin-bottom:3px;">Cached Patterns:</div>';
              const tags = d.patterns.slice(0, 10).map(p => '<span style="background:#1a1a2a;border:1px solid #2a2a4a;border-radius:4px;padding:1px 5px;font-size:9px;color:#888;">' + p.value + ' ×' + p.frequency + '</span>').join(' ');
              html += '<div style="display:flex;flex-wrap:wrap;gap:3px;">' + tags + '</div>';
              if (d.patterns.length > 10) html += '<div style="color:#666;font-size:10px;margin-top:2px;">+ ' + (d.patterns.length - 10) + ' more</div>';
              html += '</div>';
            }
            html += '</div>';
          }
        }
        html += '<div style="margin-top:8px;display:flex;gap:6px;">';
        html += '<button class="ctrl-btn" onclick="nsmRefresh()" style="font-size:10px;padding:3px 8px;border-color:#4affa0;color:#4affa0;">Refresh</button>';
        html += '<button class="ctrl-btn" onclick="nsmAcquireDomain()" style="font-size:10px;padding:3px 8px;border-color:#c8c84a;color:#c8c84a;">+ Acquire Domain</button>';
        html += '</div>';
        const el = document.querySelector('[data-rawcontent="' + cardId + '"]');
        if (el) el.innerHTML = html;
        card.content = html;
        await updateCard(cardId, { content: html, rawHtml: true });
      } catch (e) {
        const el = document.querySelector('[data-rawcontent="' + cardId + '"]');
        if (el) el.innerHTML = '<div style="color:#ff4a6a;">Failed to load NSM: ' + e.message + '</div>';
      }
    }

    async function nsmRefresh() {
      return openNSM();
    }

    async function nsmAcquireDomain() {
      const domain = prompt('Domain name to acquire:');
      if (!domain) return;
      try {
        const res = await fetch('/api/nsm/domains', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, principles: [] }),
        });
        const data = await res.json();
        if (data.ok) {
          showToast('Domain "' + domain + '" acquired', 'success');
          openNSM();
        } else {
          showToast('Failed: ' + (data.error || 'unknown'), 'error');
        }
      } catch (e) {
        showToast('Error: ' + e.message, 'error');
      }
    }

    init();
  </script>
</body>
</html>
`
var server_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // A router shape borrowed from Cloudflare OS: one prefix, and whichever
    // specialist is bound answers it. Unbound is a clean miss, not a crash - the
    // same fail-safe every other binding here uses. Nothing is bound today, so
    // this route answers 404 and changes no existing path.
    if (url.pathname.startsWith("/gatekeeper/")) {
      const wanted = url.pathname.split("/")[2] || "";
      const bindingName = "GATEKEEPER_" + wanted.toUpperCase().replace(/-/g, "_");
      // The bindings in this account carry the owner's own names, so the door
      // answers to both: GATEKEEPER_<NAME> where it exists, and these where the
      // cfos services are bound under their short names.
      const aliases = { context: "CFCXT", websearch: "CFWB", scheduler: "CFCAL", backend: "CFBE", os: "CFOS" };
      const specialist = wanted ? env[bindingName] || env[aliases[wanted]] : null;
      if (!specialist || typeof specialist.fetch !== "function") {
        return json({ error: "no_gatekeeper", gatekeeper: wanted || null, binding: bindingName }, 404);
      }
      return specialist.fetch(request);
    }
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      const orproxyReady = !!(env.ORPROXY && typeof env.ORPROXY.fetch === "function");
      return json({
        status: "ok",
        worker: "tew",
        version: env.VERSION || "dev",
        time: (/* @__PURE__ */ new Date()).toISOString(),
        bindings: {
          ai: !!env.AI,
          workspace: !!env.WORKSPACE,
          orproxy: orproxyReady,
          truth: !!(env.TRUTH && typeof env.TRUTH.fetch === "function"),
          r2: !!env.R2,
          kv: {
            context: !!env.CONTEXT_KV,
            namespaces: !!env.KV_NAMESPACES,
            orp: !!env.ORP_KV,
            audits: !!env.AUDITS_KV
          }
        },
        features: {
          cards: true,
          principles: true,
          nsm: !!memoryKv(env),
          import: !!env.AI,
          domainAssets: !!env.R2,
          deepInstruct: orproxyReady || !!env.OPENROUTER_API_KEY,
          stream: false
        }
      });
    }
    if (!url.pathname.startsWith("/api/")) {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8", ...cors() }
      });
    }
    try {
      const workspaceId = url.searchParams.get("ws") || "default";
      const id = env.WORKSPACE.idFromName(workspaceId);
      const stub = env.WORKSPACE.get(id);
      return stub.fetch(request);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};
var DomainManager = class {
  constructor(kv, r2, domain) {
    this.kv = kv;
    this.r2 = r2;
    this.domain = domain;
  }
  async getPrinciples() {
    try {
      const cached = await this.kv.get(KvKeys.principles(this.domain), { type: "json" });
      if (cached) return cached;
    } catch {
    }
    return null;
  }
  async syncPrinciples(principles) {
    try {
      await this.kv.put(KvKeys.principles(this.domain), JSON.stringify(principles), {
        expirationTtl: 3600
      });
    } catch {
    }
  }
  async getStack() {
    try {
      return await this.kv.get(KvKeys.stack(this.domain), { type: "json" });
    } catch {
      return null;
    }
  }
  async setStack(stack) {
    try {
      await this.kv.put(KvKeys.stack(this.domain), JSON.stringify(stack), {
        expirationTtl: 86400
      });
    } catch {
    }
  }
  async getCachedQuery(queryId) {
    try {
      return await this.kv.get(KvKeys.queryCache(this.domain, queryId), { type: "json" });
    } catch {
      return null;
    }
  }
  async cacheQuery(queryId, result) {
    try {
      await this.kv.put(KvKeys.queryCache(this.domain, queryId), JSON.stringify(result), {
        expirationTtl: 300
      });
    } catch {
    }
  }
  async getCachedAudit(auditId) {
    try {
      return await this.kv.get(KvKeys.auditCache(this.domain, auditId), { type: "json" });
    } catch {
      return null;
    }
  }
  async cacheAudit(auditId, result) {
    try {
      await this.kv.put(KvKeys.auditCache(this.domain, auditId), JSON.stringify(result), {
        expirationTtl: 600
      });
    } catch {
    }
  }
  async getSearchCache(queryHash) {
    try {
      return await this.kv.get(KvKeys.searchCache(this.domain, queryHash), { type: "json" });
    } catch {
      return null;
    }
  }
  async cacheSearch(queryHash, results) {
    try {
      await this.kv.put(KvKeys.searchCache(this.domain, queryHash), JSON.stringify(results), {
        expirationTtl: 300
      });
    } catch {
    }
  }
  async storeImport(id, filename, bytes, contentType) {
    try {
      const key = R2Paths.import(this.domain, id, filename);
      await this.r2.put(key, bytes, { httpMetadata: { contentType } });
      return key;
    } catch {
      return null;
    }
  }
  async getImport(id, filename) {
    try {
      return await this.r2.get(R2Paths.import(this.domain, id, filename));
    } catch {
      return null;
    }
  }
  async storeSnapshot(cardId, content) {
    try {
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const key = R2Paths.snapshot(this.domain, cardId, ts);
      await this.r2.put(key, content, { httpMetadata: { contentType: "application/json" } });
      return key;
    } catch {
      return null;
    }
  }
  async storeTemplate(templateId, content) {
    try {
      const key = R2Paths.template(this.domain, templateId);
      await this.r2.put(key, content, { httpMetadata: { contentType: "application/json" } });
      return key;
    } catch {
      return null;
    }
  }
  async getTemplate(templateId) {
    try {
      return await this.r2.get(R2Paths.template(this.domain, templateId));
    } catch {
      return null;
    }
  }
  async listAssets(prefix = "") {
    try {
      const fullPrefix = R2Paths.listPrefix(this.domain, prefix);
      const listed = await this.r2.list({ prefix: fullPrefix });
      return listed.objects || [];
    } catch {
      return [];
    }
  }
  async getStats() {
    try {
      const principles = await this.getPrinciples();
      const assets = await this.listAssets();
      return {
        principleCount: principles?.length || 0,
        assetCount: assets.length,
        domain: this.domain
      };
    } catch {
      return { principleCount: 0, assetCount: 0, domain: this.domain };
    }
  }
};
function memoryKv(env) {
  if (!env) return null;
  return env.CONTEXT_KV || env.KV_NAMESPACES || env.ORP_KV || env.AUDITS_KV || env.KV || null;
}

var SEARX_DEFAULT = "https://searing-render.fly.dev";
var SEARX_TIMEOUT_DEFAULT = 6e4;
var SEARX_HEDGE_DEFAULT = 4e3;
var SEARX_FALLBACK_TIMEOUT_DEFAULT = 15e3;
function searxBase(env) {
  return env && env.SEARX_URL ? String(env.SEARX_URL).replace(/\/+$/, "") : SEARX_DEFAULT;
}
function searxFallback(env) {
  const url = env && env.SEARX_FALLBACK_URL ? String(env.SEARX_FALLBACK_URL).replace(/\/+$/, "") : "";
  return url && url !== searxBase(env) ? url : "";
}
function searxNumber(env, key, fallback) {
  const n = Number(env && env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function searxTimeout(env) {
  return searxNumber(env, "SEARX_TIMEOUT_MS", SEARX_TIMEOUT_DEFAULT);
}
function searxHedgeMs(env) {
  return searxNumber(env, "SEARX_HEDGE_MS", SEARX_HEDGE_DEFAULT);
}
function searxFallbackTimeout(env) {
  return searxNumber(env, "SEARX_FALLBACK_TIMEOUT_MS", SEARX_FALLBACK_TIMEOUT_DEFAULT);
}
async function searxQuery(base, query, timeoutMs) {
  const endpoint = base + "/search?q=" + encodeURIComponent(query) + "&format=json&safesearch=0";
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "tew-worker/1.0 (+SearXNG client)"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error("returned " + response.status);
  const data = await response.json().catch(() => null);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, 15).map((r, i) => ({
    id: "web_" + i,
    title: r.title || r.url || "Untitled",
    url: r.url || "",
    snippet: (r.content || "").slice(0, 300),
    type: "web",
    engine: r.engine || r.engines || null
  }));
}
function searxDescribe(failure) {
  if (failure.error && failure.error.name === "TimeoutError") {
    return failure.backend + " timed out after " + Math.round(failure.timeoutMs / 1e3) + "s";
  }
  return failure.backend + " " + (failure.error && failure.error.message ? failure.error.message : "failed");
}
function searxFirstSuccess(runs) {
  return new Promise((resolve, reject) => {
    const failures = [];
    let pending = runs.length;
    for (const run of runs) {
      run.then((outcome) => {
        if (outcome.ok) {
          resolve(outcome);
          return;
        }
        failures.push(outcome);
        if (--pending === 0) reject(failures);
      });
    }
  });
}
async function searxSearch(env, query) {
  const attempt = (base, timeoutMs) => searxQuery(base, query, timeoutMs).then(
    (hits) => ({ ok: true, hits, backend: base }),
    (error) => ({ ok: false, error, backend: base, timeoutMs })
  );
  const primary = searxBase(env);
  const primaryRun = attempt(primary, searxTimeout(env));
  const fallback = searxFallback(env);
  if (!fallback) {
    const only = await primaryRun;
    if (only.ok) return { hits: only.hits, backend: only.backend };
    const error = new Error(searxDescribe(only));
    error.timeout = !!only.error && only.error.name === "TimeoutError";
    throw error;
  }
  const hedge = await Promise.race([
    primaryRun,
    new Promise((resolve) => setTimeout(() => resolve({ hedged: true }), searxHedgeMs(env)))
  ]);
  if (hedge.ok) return { hits: hedge.hits, backend: hedge.backend };
  const runs = [attempt(fallback, searxFallbackTimeout(env))];
  if (hedge.hedged) runs.push(primaryRun);
  try {
    const winner = await searxFirstSuccess(runs);
    return { hits: winner.hits, backend: winner.backend };
  } catch (failures) {
    const all = hedge.hedged ? failures : [hedge, ...failures];
    const error = new Error(all.map(searxDescribe).join("; "));
    error.timeout = all.every((f) => f.error && f.error.name === "TimeoutError");
    throw error;
  }
}
// The watchtower reads each tool from here, never from the browser: mind and
// truth send no CORS headers, so a page cannot read them directly.
var WATCH_DEFAULTS = [
  { name: "tew", base: "https://tew.ai-n.workers.dev", path: "/health" },
  { name: "cods", base: "https://cods.ai-n.workers.dev", path: "/health" },
  { name: "truth", base: "https://truth.ai-n.workers.dev", path: "/debug/kv-status" },
  { name: "mind", base: "https://mind.ai-n.workers.dev", path: "/" },
  { name: "ara", base: "https://ara.ai-n.workers.dev", path: "/health" }
];
function adminGate(env, request) {
  const want = String((env && env.ADMIN_KEY) || "").trim();
  if (!want) {
    return json({ error: "admin_not_configured", message: "Set ADMIN_KEY on this Worker." }, 503);
  }
  const given = String(request.headers.get("x-admin-key") || "").trim();
  let drift = given.length ^ want.length;
  for (let i = 0; i < Math.max(given.length, want.length); i++) {
    drift |= (given.charCodeAt(i) || 0) ^ (want.charCodeAt(i) || 0);
  }
  return drift === 0 ? null : json({ error: "admin_key_required", message: "Send ADMIN_KEY in x-admin-key." }, 401);
}
function watchDetail(parsed, text) {
  if (parsed && typeof parsed === "object") {
    const bits = [];
    if (parsed.status) bits.push(String(parsed.status));
    if (parsed.worker) bits.push(String(parsed.worker));
    if (parsed.version) bits.push(String(parsed.version));
    if (parsed.proxyBound !== void 0) bits.push(parsed.proxyBound ? "proxy bound" : "proxy unbound");
    if (parsed.error) bits.push(String(parsed.error));
    if (bits.length) return bits.join(" \u00b7 ");
  }
  const flat = String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 60) : null;
}
async function probeTool(tool) {
  const started = Date.now();
  const base = String((tool && (tool.base || tool.url)) || "").replace(/\/$/, "");
  const path = String((tool && tool.path) || "/health");
  const row = { name: (tool && tool.name) || base, base: base, path: path };
  try {
    const res = await fetch(base + path, { method: "GET", signal: AbortSignal.timeout(10000) });
    const kind = String(res.headers.get("content-type") || "");
    const text = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
    // A tool with no health route still answers; say that instead of scraping its page.
    const detail = parsed === null && /html/i.test(kind)
      ? (res.ok ? "answers \u00b7 no health route" : "status " + res.status)
      : watchDetail(parsed, text);
    return Object.assign(row, { ok: res.ok, status: res.status, ms: Date.now() - started, detail: detail, checkedAt: (new Date()).toISOString() });
  } catch (err) {
    return Object.assign(row, { ok: false, status: 0, ms: Date.now() - started, detail: "unreachable: " + String((err && err.message) || err), checkedAt: (new Date()).toISOString() });
  }
}

// ─── the learning ladder ─────────────────────────────────────────────────────
// TEW is the top of the ladder: one ledger, scored here, so every tool that
// reads it behaves the same. The shape is cods' own rows, plus which tool
// taught it. A row is never deleted by the machine; it is held, or forgotten
// by him on purpose.
const LEARN_STORE = "LEARN:ledger";
const LEARN_USE = 0.2;
const LEARN_CANDIDATE = 0.5;
const LEARN_EARN = 3;
const LEARN_STOP = new Set(["about", "after", "again", "answer", "answers", "before", "being", "could", "every", "first", "found", "given", "going", "here", "there", "these", "those", "which", "while", "would", "should", "still", "where", "thing", "things", "using", "wants", "write", "wrote", "this", "that", "from", "with", "have", "what", "want", "your", "they", "them", "when", "then", "just", "like", "card", "cards", "know", "must", "will", "been", "into", "over", "only", "also", "than", "more", "most", "each", "some", "such", "very", "does", "done", "give", "make", "made", "take", "same", "both"]);

function learnWords(text) {
  const out = [];
  String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).forEach((wd) => {
    if (wd.length < 4 || LEARN_STOP.has(wd)) return;
    const stem = wd.replace(/s$/, "");
    if (out.indexOf(stem) < 0) out.push(stem);
  });
  return out;
}
function learnMatch(row, prompt) {
  const want = learnWords(prompt);
  const has = learnWords(String((row && row.q) || "") + " " + String((row && row.a) || ""));
  if (!want.length || !has.length) return { score: 0, same: [], differ: has.slice(0, 5) };
  const same = want.filter((wd) => has.indexOf(wd) >= 0);
  const differ = has.filter((wd) => want.indexOf(wd) < 0).slice(0, 5);
  return { score: Math.min(1, same.length / Math.max(1, Math.min(want.length, has.length))), same, differ };
}
function learnAlike(x, y) {
  const A = learnWords(x);
  const B = learnWords(y);
  if (!A.length || !B.length) return 0;
  const same = A.filter((wd) => B.indexOf(wd) >= 0).length;
  return same / (A.length + B.length - same);
}
function learnCounts(ledger) {
  const rows = (ledger && ledger.rows) || [];
  return {
    total: rows.length,
    active: rows.filter((r) => r && r.status !== "candidate").length,
    candidate: rows.filter((r) => r && r.status === "candidate").length,
    rules: Object.keys((ledger && ledger.domains) || {}).length
  };
}
async function loadLedger(dobj) {
  const raw = await dobj.ctx.storage.get(LEARN_STORE);
  const l = raw && typeof raw === "object" ? raw : {};
  l.rows = Array.isArray(l.rows) ? l.rows : [];
  l.domains = l.domains && typeof l.domains === "object" ? l.domains : {};
  l.events = Array.isArray(l.events) ? l.events : [];
  return l;
}
async function saveLedger(dobj, ledger) {
  ledger.rows = ledger.rows.slice(-200);
  ledger.events = ledger.events.slice(-50);
  ledger.updated = (new Date()).toISOString();
  await dobj.ctx.storage.put(LEARN_STORE, ledger);
}
// Moving a row is the machine's half: it holds what does not fit and lifts back
// what does. His own rows and anything he kept are never held.
function learnTend(ledger, prompt) {
  let moved = 0;
  for (const row of ledger.rows) {
    if (!row) continue;
    const m = learnMatch(row, prompt || "");
    row.fit = Number(m.score.toFixed(2));
    row.same = m.same.slice(0, 4);
    row.differs = m.differ.slice(0, 4);
    const fits = m.score >= LEARN_USE;
    if (row.tier === "his" || row.kept) continue;
    if (row.status === "candidate") {
      if (fits) {
        row.hits = (row.hits || 0) + 1;
        if (row.hits >= LEARN_EARN) {
          row.status = "active";
          row.earned = (new Date()).toISOString();
          row.why = null;
        }
        moved += 1;
      }
    } else if (!fits) {
      row.status = "candidate";
      row.hits = row.hits || 0;
      row.why = "not relevant to " + String(prompt || "").slice(0, 60);
      row.moved = (new Date()).toISOString();
      moved += 1;
    }
  }
  return moved;
}
function learnHint(ledger, prompt, domain) {
  const rows = (ledger && ledger.rows) || [];
  const dom = String(domain || "").trim().toLowerCase();
  const his = rows.filter((r) => r && r.tier === "his" && r.status !== "candidate").slice(-8);
  const rules = dom && ledger.domains[dom] && Array.isArray(ledger.domains[dom]) ? ledger.domains[dom] : [];
  const learned = rows
    .filter((r) => r && r.tier !== "his")
    .map((r) => ({ r: r, m: learnMatch(r, prompt) }))
    .filter((x) => x.r.status !== "candidate" || x.m.score >= LEARN_CANDIDATE)
    .sort((x, y) => y.m.score - x.m.score)
    .slice(0, 4);
  const parts = [];
  if (his.length) {
    parts.push("His own preferences, above the domain rules and above anything learned in chat:\n" + his.map((r) => "- " + String(r.a || "").slice(0, 300)).join("\n"));
  }
  if (rules.length) {
    parts.push("Principles for " + dom + ", above anything learned in chat:\n" + rules.map((x) => "- " + String((x && x.text) || "").slice(0, 300)).join("\n"));
  }
  if (learned.length) {
    parts.push("Learned in chat, below the two levels above:\n" + learned.map((x) => String(x.r.q || "").slice(0, 90) + " -> " + String(x.r.a || "").slice(0, 400) + " [fits " + x.m.score.toFixed(2) + (x.r.status === "candidate" ? ", candidate" : "") + "]").join("; "));
  }
  return { hint: parts.length ? "Learned from this user: " + parts.join("; ") + "." : "", picked: learned };
}
function sameKey(given, want) {
  const a = String(given || "").trim();
  const b = String(want || "").trim();
  let drift = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) drift |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return drift === 0;
}


// ─── the deciders ────────────────────────────────────────────────────────────
// Who decides, what it costs, and how long it takes. A decision model answers a
// typed question and writes nothing, so picking one is a comparison on his own
// asks: the same state, the same questions, every model, side by side. The cost
// comes back with the answer; the milliseconds are measured here.
const DECIDE_MODELS = [
  { id: "perplexity/pplx-decider-flash-v1.2", label: "pplx flash", list: "$0.01/M" },
  { id: "perplexity/pplx-decider-v1.2", label: "pplx joint", list: "$0.02/M" },
  { id: "scaledown/classify-1", label: "scaledown", list: "$0.04/M" }
];
const DECIDE_STORE = "DECIDE:choice";
const DECIDE_BUDGET = "DECIDE:budget";
const DECIDE_PER_HOUR = 10;
function decideHourOf(d) { return d.toISOString().slice(0, 13); }
function decideRounded(n) { return typeof n === "number" && isFinite(n) ? Math.round(n * 1000) / 1000 : null; }
function decideSpread(p) {
  if (!p || typeof p !== "object") return null;
  return Object.keys(p).map(function (k) { return { option: k, p: decideRounded(p[k]) }; })
    .sort(function (a, b) { return (b.p || 0) - (a.p || 0); }).slice(0, 3);
}
function decideQuestions() {
  return {
    intent: {
      type: "choice",
      instructions: "He has handed you this. Which is it: a result he wants produced, a preset he wants run, or something he is asking?",
      criteria: {
        result: "A result — the thing itself, produced: what the store already holds, or the artifact built. No new prose.",
        preset: "A preset run — one of the fixed prompts he has saved, run on this.",
        ask: "Something he is asking — a question that wants an answer.",
        unclear: "I am not sure which of these he wants — ask him."
      }
    },
    route: {
      type: "choice",
      instructions: "Which surface does this belong on?",
      criteria: {
        truth: "the stored answer, if the store has one",
        cards: "the card workspace and its table",
        browse: "the live web, read first",
        general: "no particular surface"
      }
    }
  };
}
// The ladder as ai-proxy routes it: no model named, so the service picks. What it
// answers says whether its own choice is the same ask the models gave theirs on.
async function ladderView(env, ask) {
  const out = { label: "ladder (ai-proxy)", model: "ai-proxy:/api/decide", ok: false, ms: null };
  const binding = env && env["AI-PROXY"];
  if (!binding || typeof binding.fetch !== "function") { out.error = "AI-PROXY is not bound"; return out; }
  const started = Date.now();
  try {
    const res = await binding.fetch(new Request("https://ai-proxy/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: ask, questions: decideQuestions() }),
      signal: AbortSignal.timeout(20000)
    }));
    out.ms = Date.now() - started;
    out.status = res.status;
    const data = await res.json().catch(function () { return null; });
    if (!res.ok || !data) { out.error = "http " + res.status; return out; }
    const intent = (data.answers && data.answers.intent) || null;
    const route = (data.answers && data.answers.route) || null;
    out.ok = true;
    out.served = data.model || null;
    out.choice = (intent && intent.choice) || null;
    out.confidence = decideRounded(intent && intent.confidence);
    out.spread = decideSpread(intent && intent.probabilities);
    out.route = (route && route.choice) || null;
    out.cost = (data.usage && typeof data.usage.cost === "number") ? data.usage.cost : null;
  } catch (err) {
    out.ms = Date.now() - started;
    out.error = String((err && err.message) || err);
  }
  return out;
}

// What the decider has actually done, read from ARA's own rows. A probe shows
// what each model would do with one ask; this shows what the one in use has been
// doing, priced the same way.
async function araTraffic(env, limit) {
  const take = Math.max(1, Math.min(60, Number(limit) || 30));
  try {
    const araKey = String((env && (env.ARA_KEY || env.ADMIN_KEY)) || "").trim();
    const res = await fetch("https://ara.ai-n.workers.dev/recent?limit=" + take, {
      headers: araKey ? { "x-admin-key": araKey } : {},
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { ok: false, error: "http " + res.status, models: [], rows: [] };
    const data = await res.json().catch(function () { return null; });
    const rows = (data && data.decisions) || [];
    const by = {};
    rows.forEach(function (r) {
      const name = r.model || "no decider";
      const slot = by[name] || (by[name] = { model: name, n: 0, ms: [], cost: 0 });
      slot.n += 1;
      if (typeof r.ms === "number") slot.ms.push(r.ms);
      if (typeof r.cost === "number") slot.cost += r.cost;
    });
    const models = Object.keys(by).map(function (k) {
      const slot = by[k];
      const sorted = slot.ms.slice().sort(function (a, b) { return a - b; });
      return {
        model: slot.model,
        n: slot.n,
        msMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        cost: Math.round(slot.cost * 1000000) / 1000000
      };
    }).sort(function (a, b) { return b.n - a.n; });
    return { ok: true, models: models, rows: rows.slice(0, 6).map(function (r) {
      return { at: r.at, asked: String(r.asked || "").slice(0, 80), decided: r.decided, model: r.model || null,
               cost: typeof r.cost === "number" ? r.cost : null, ms: typeof r.ms === "number" ? r.ms : null };
    }), total: rows.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), models: [], rows: [] };
  }
}

// The proxy is the transport: orproxy forwards to ai-proxy, which holds the key
// and returns usage.cost. TEW never needs the OpenRouter key of its own.
async function runDecider(env, model, ask) {
  const started = Date.now();
  const out = { model: model.id, label: model.label, list: model.list, ok: false, ms: null };
  const hasKey = Boolean(env && String(env.OPENROUTER_API_KEY || "").trim());
  const hasProxy = Boolean(env && env.ORPROXY && typeof env.ORPROXY.fetch === "function");
  if (!hasKey && !hasProxy) {
    out.error = "no OpenRouter transport (OPENROUTER_API_KEY and ORPROXY are both missing)";
    return out;
  }
  try {
    // The key first: that is the path ARA takes, so the milliseconds mean the
    // same thing. The proxy is the fallback, and the row says which one answered.
    const payload = JSON.stringify({ model: model.id, state: ask, questions: decideQuestions() });
    const key = String((env && env.OPENROUTER_API_KEY) || "").trim();
    const via = key ? "key" : "proxy";
    out.via = via;
    let res;
    if (key) {
      res = await fetch("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(20000)
      });
    } else if (env && env.ORPROXY && typeof env.ORPROXY.fetch === "function") {
      res = await env.ORPROXY.fetch(new Request("https://orproxy/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(20000)
      }));
    } else {
      out.error = "no OpenRouter transport (OPENROUTER_API_KEY and ORPROXY are both missing)";
      return out;
    }
    out.ms = Date.now() - started;
    out.status = res.status;
    const data = await res.json().catch(function () { return null; });
    if (!res.ok || !data) { out.error = "http " + res.status; return out; }
    const intent = (data.answers && data.answers.intent) || null;
    const route = (data.answers && data.answers.route) || null;
    out.ok = true;
    out.served = data.model || null;
    out.choice = (intent && intent.choice) || null;
    out.confidence = decideRounded(intent && intent.confidence);
    out.spread = decideSpread(intent && intent.probabilities);
    out.route = (route && route.choice) || null;
    out.routeConfidence = decideRounded(route && route.confidence);
    out.cost = (data.usage && typeof data.usage.cost === "number") ? data.usage.cost : null;
    out.tokensIn = (data.usage && data.usage.input_tokens) || null;
    out.costUpstream = (data.usage && data.usage.cost_details && data.usage.cost_details.upstream_inference_cost != null)
      ? data.usage.cost_details.upstream_inference_cost : null;
  } catch (err) {
    out.ms = Date.now() - started;
    out.error = String((err && err.message) || err);
  }
  return out;
}

var Workspace = class extends DurableObject {
  cards = null;
  principles = null;
  clusters = {};
  domainStacks = {};
  llm = null;
  nsm = null;
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }
  async ensureLoaded() {
    if (this.cards !== null) return;
    this.cards = await this.ctx.storage.get("cards") ?? [];
    this.principles = await this.ctx.storage.get("principles") ?? [];
    this.clusters = await this.ctx.storage.get("clusters") ?? {};
    this.domainStacks = await this.ctx.storage.get("domainStacks") ?? {};
  }
  async persist() {
    await this.ctx.storage.put("cards", this.cards);
    await this.ctx.storage.put("principles", this.principles);
    await this.ctx.storage.put("clusters", this.clusters);
    await this.ctx.storage.put("domainStacks", this.domainStacks);
  }
  getLLM() {
    if (!this.llm && this.env) {
      this.llm = new LLMRouter(
        this.env.AI,
        this.env.OPENROUTER_API_KEY || "",
        this.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        this.getNSM(),
        this.env.ORPROXY || null
      );
    }
    return this.llm;
  }
  async resolveTruth(query) {
    if (!this.env || !this.env.TRUTH || typeof this.env.TRUTH.fetch !== "function") return null;
    try {
      const response = await this.env.TRUTH.fetch("https://truth/api/truth/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: query }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || data.status !== "ok" || typeof data.answer !== "string" || !data.answer.trim()) return null;
      return data;
    } catch {
      return null;
    }
  }
  getNSM() {
    if (!this.nsm && this.env) {
      this.nsm = new NSM_CLASS(this.env.CONTEXT_KV || null);
    }
    return this.nsm;
  }
  getDomainManager(domain) {
    if (!this.env) return null;
    return new DomainManager(memoryKv(this.env), this.env.R2, domain);
  }
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
      }
    }
  }
  broadcastPresence() {
    this.broadcast({ type: "presence", count: this.ctx.getWebSockets().length });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }
      const clientId = crypto.randomUUID();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ clientId });
      await this.ensureLoaded();
      server.send(JSON.stringify({ type: "cards", cards: this.cards }));
      server.send(JSON.stringify({ type: "principles", principles: this.principles }));
      server.send(JSON.stringify({ type: "clusters", clusters: this.clusters }));
      this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: client });
    }
    await this.ensureLoaded();
    if (url.pathname === "/api/cards" && request.method === "GET") {
      return json(this.cards);
    }
    if (url.pathname === "/api/cards" && request.method === "POST") {
      const body = await request.json();
      const card = {
        id: "card_" + crypto.randomUUID(),
        type: body.type ?? "Document",
        title: body.title ?? "Untitled",
        content: body.content ?? "",
        rawHtml: body.rawHtml,
        relationships: [],
        url: body.url,
        x: body.x ?? 0,
        y: body.y ?? 0,
        width: body.width ?? null,
        height: body.height ?? null,
        dockedTo: body.dockedTo ?? null,
        dockEdge: body.dockEdge ?? null,
        domains: body.domains ?? [],
        domain: body.domain,
        view: body.view,
        assets: body.assets,
        principleCount: body.principleCount,
        activeStack: body.activeStack,
        splitView: body.splitView ?? false,
        confidence: null,
        eitlStatus: body.eitlStatus ?? null,
        eitlReview: body.eitlReview,
        source: body.source,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(card);
      await this.persist();
      this.broadcast({ type: "card_created", card });
      return json(card, 201);
    }
    const idMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (idMatch && request.method === "GET") {
      const id = decodeURIComponent(idMatch[1]);
      const card = this.cards.find((c) => c.id === id);
      if (!card) return json({ error: "Card not found" }, 404);
      return json(card);
    }
    if (idMatch && request.method === "DELETE") {
      const id = decodeURIComponent(idMatch[1]);
      this.cards = this.cards.filter((c) => c.id !== id);
      await this.persist();
      this.broadcast({ type: "card_deleted", id });
      return json({ ok: true });
    }
    if (idMatch && request.method === "PATCH") {
      const id = decodeURIComponent(idMatch[1]);
      const card = this.cards.find((c) => c.id === id);
      if (!card) return json({ error: "Card not found" }, 404);
      const body = await request.json();
      if (body.title !== void 0) card.title = body.title;
      if (body.content !== void 0) card.content = body.content;
      if (body.type !== void 0) card.type = body.type;
      // A browser card's address is part of its state: without this, navigating
      // the frame worked and the card kept the old URL, so the page came back as
      // the last one on the next render.
      if (body.url !== void 0) card.url = body.url;
      if (body.rawHtml !== void 0) card.rawHtml = body.rawHtml;
      if (body.x !== void 0) card.x = body.x;
      if (body.y !== void 0) card.y = body.y;
      if (body.width !== void 0) card.width = body.width;
      if (body.height !== void 0) card.height = body.height;
      if (body.dockedTo !== void 0) card.dockedTo = body.dockedTo;
      if (body.dockEdge !== void 0) card.dockEdge = body.dockEdge;
      if (body.domains !== void 0) card.domains = body.domains;
      if (body.splitView !== void 0) card.splitView = body.splitView;
      if (body.confidence !== void 0) card.confidence = body.confidence;
      if (body.eitlStatus !== void 0) card.eitlStatus = body.eitlStatus;
      card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      await this.persist();
      this.broadcast({ type: "card_updated", card });
      return json(card);
    }
    if (url.pathname === "/api/proxy" && request.method === "GET") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return new Response("Missing url param", { status: 400 });
      try {
        new URL(targetUrl);
      } catch {
        return new Response("Invalid URL", { status: 400 });
      }
      try {
        const resp = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5"
          },
          cf: { cacheTtl: 60 }
        });
        const headers = new Headers(resp.headers);
        headers.delete("x-frame-options");
        headers.delete("content-security-policy");
        headers.delete("content-security-policy-report-only");
        headers.delete("permissions-policy");
        headers.set("access-control-allow-origin", "*");
        const contentType = headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
          let html = await resp.text();
          const target = new URL(targetUrl);
          html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${target.origin}/">`);
          headers.delete("content-length");
          return new Response(html, { status: resp.status, headers });
        }
        return new Response(resp.body, { status: resp.status, headers });
      } catch (err) {
        return new Response(`<html><body style="font-family:sans-serif;padding:40px;background:#1a1a2e;color:#e0e0e0"><h2>Failed to load</h2><p style="color:#ff6b1a">${err.message}</p><p style="color:#888;font-size:13px">${targetUrl}</p></body></html>`, {
          status: 502,
          headers: { "content-type": "text/html" }
        });
      }
    }
    if (url.pathname === "/api/fetch" && request.method === "POST") {
      const { url: fetchUrl } = await request.json();
      if (!fetchUrl) return json({ error: "URL required" }, 400);
      try {
        const response = await fetch(fetchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TruthEngine/1.0)" },
          cf: { cacheTtl: 300 }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rawHtml = await response.text();
        const parsed = parsePage(rawHtml, fetchUrl);
        const card = {
          id: "card_" + crypto.randomUUID(),
          type: "Browser",
          title: parsed.title,
          content: parsed.content,
          rawHtml,
          relationships: [],
          url: fetchUrl,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        this.cards.push(card);
        await this.persist();
        this.broadcast({ type: "card_created", card });
        return json(card, 201);
      } catch (err) {
        return json({ error: `Fetch failed: ${err.message}` }, 502);
      }
    }
    if (url.pathname === "/api/import" && request.method === "POST") {
      const { filename, mimeType, data, domain } = await request.json();
      if (!data) return json({ error: "No file data" }, 400);
      const binaryStr = atob(data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      let extractedText = "";
      let cardTitle = filename.replace(/\.[^.]+$/, "");
      if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
        const input = mimeType.startsWith("image/") ? { image: Array.from(bytes) } : { document: Array.from(bytes) };
        const systemPrompt = mimeType.startsWith("image/") ? "You are a document analysis engine. Describe this image in detail. Extract any visible text, describe the layout, and identify key elements. Be thorough but concise." : "You are a PDF document parser. Extract ALL text content from this PDF document. Preserve the structure: headings, paragraphs, lists, tables. Output clean, readable text with proper markdown formatting (## for headings, - for lists, etc). Preserve all information faithfully.";
        const nsmMessages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: mimeType.startsWith("image/") ? [{ type: "image", image: input.image }] : `Extract and format all text content from this document. Preserve headings, lists, and structure.` }
        ];
        const nsm = this.getNSM();
        const { messages: nsmEnriched, metadata: nsmMeta } = nsm ? await nsm.wrap(nsmMessages, "import", domain ? { domain } : {}) : { messages: nsmMessages, metadata: null };
        const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: nsmEnriched,
          max_tokens: 2048
        });
        extractedText = aiResponse.response ?? JSON.stringify(aiResponse);
        if (nsm && extractedText && nsmMeta) await nsm.postProcess(extractedText, nsmMeta.domain, "import");
      } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        try {
          const uint8arr = new Uint8Array(bytes);
          const textContent = [];
          const decoder = new TextDecoder("utf-8", { fatal: false });
          const fullText = decoder.decode(uint8arr);
          const wtMatches = fullText.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
          if (wtMatches && wtMatches.length > 0) {
            for (const match of wtMatches) {
              const text = match.replace(/<[^>]+>/g, "").trim();
              if (text) textContent.push(text);
            }
            const paragraphs = fullText.match(/<w:p[^>]*>[\s\S]*?<\/w:p>/g) || [];
            let lastStyle = "";
            const structuredContent = [];
            for (const p of paragraphs) {
              const styleMatch = p.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
              const style = styleMatch ? styleMatch[1] : "";
              const pText = (p.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "").trim()).filter(Boolean).join(" ");
              if (!pText) continue;
              if (style.includes("Heading1")) structuredContent.push(`
## ${pText}`);
              else if (style.includes("Heading2")) structuredContent.push(`
### ${pText}`);
              else if (style.includes("Heading3")) structuredContent.push(`
#### ${pText}`);
              else if (style.includes("List")) structuredContent.push(`- ${pText}`);
              else structuredContent.push(pText);
            }
            extractedText = structuredContent.length > 0 ? structuredContent.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() : textContent.join("\n\n");
          } else {
            extractedText = fullText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8e3);
          }
        } catch {
          extractedText = "(Could not parse DOCX \u2014 file may be corrupted)";
        }
      } else {
        return json({ error: `Unsupported file type: ${mimeType}` }, 400);
      }
      const card = {
        id: "card_" + crypto.randomUUID(),
        type: "Document",
        title: cardTitle,
        content: extractedText,
        relationships: [],
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(card);
      await this.persist();
      this.broadcast({ type: "card_created", card });
      return json(card, 201);
    }
    if (url.pathname === "/api/cards/manipulate" && request.method === "POST") {
      const { action, cardIds, promptText } = await request.json();
      const targets = this.cards.filter((c) => cardIds.includes(c.id));
      if (targets.length === 0) return json({ error: "No matching cards found" }, 400);
      const combined = targets.map((c) => `--- CARD [${c.title}] (${c.type}) ---
${c.content}`).join("\n\n");
      const systemPrompt = "You are the Truth Engine core card processor. You operate with strict factual integrity and logic \u2014 no emotion, no embellishment. Accurately manipulate, merge, or distill the provided card contents according to the user instruction. Preserve factual integrity above all.";
      const actionVerbs = {
        merge: "Merge the following card contents into a single coherent document, resolving contradictions with logic.",
        distill: "Distill the following card contents down to their essential truths and core principles. Remove noise.",
        combine: "Combine the following card contents into a unified synthesis that preserves all distinct information.",
        rewrite: "Rewrite the following card contents according to the instruction, preserving factual integrity."
      };
      const userPrompt = `${actionVerbs[action]}

Instruction: ${promptText || "(none)"}

Data:
${combined}`;
      const nsmMsgs2 = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ];
      const nsm2 = this.getNSM();
      const nsmW2 = nsm2 ? await nsm2.wrap(nsmMsgs2, "manipulate", {}) : { messages: nsmMsgs2, metadata: null };
      const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: nsmW2.messages,
        max_tokens: 1024
      });
      const resultText = aiResponse.response ?? JSON.stringify(aiResponse);
      if (nsm2 && resultText && nsmW2.metadata) await nsm2.postProcess(resultText, nsmW2.metadata.domain, "manipulate");
      const newCard = {
        id: "card_" + crypto.randomUUID(),
        type: "Document",
        title: `${action.toUpperCase()}: Result`,
        content: resultText,
        relationships: cardIds,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(newCard);
      await this.persist();
      this.broadcast({ type: "card_created", card: newCard });
      return json(newCard, 201);
    }
    if (url.pathname === "/api/principles" && request.method === "GET") {
      return json({ principles: this.principles });
    }
    if (url.pathname === "/api/principles" && request.method === "POST") {
      const body = await request.json();
      if (body.action === "approve" || !body.action && (body.domainTag === "universal" || body.domainTag === "ethical")) {
        const principle = {
          id: body.id || "princ_" + crypto.randomUUID(),
          text: body.text,
          domainTag: body.domainTag ?? "legal",
          sourceCardId: body.sourceCardId ?? null,
          sourceCitation: body.sourceCitation ?? null,
          ratificationStatus: body.ratificationStatus ?? "auto",
          ratifiedBy: body.ratifiedBy ?? "system",
          ratifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
          confidenceWeight: body.confidenceWeight ?? 1
        };
        this.principles.push(principle);
        await this.persist();
        this.broadcast({ type: "principles", principles: this.principles });
        return json({ ok: true, principle });
      }
      if (body.action === "kill") {
        return json({ ok: true, message: "Principle killed" });
      }
      return json({ error: "Invalid action" }, 400);
    }
    if (url.pathname === "/api/principles/kill" && request.method === "POST") {
      const body = await request.json();
      const principle = this.principles.find((p) => p.id === body.id);
      if (!principle) return json({ ok: true });
      if (principle.ratificationStatus === "auto") {
        return json({ error: "Constitutional immutability: universal and ethical principles cannot be removed. They are structural constraints.", immutable: true }, 403);
      }
      this.principles = this.principles.filter((p) => p.id !== body.id);
      await this.persist();
      this.broadcast({ type: "principles", principles: this.principles });
      return json({ ok: true });
    }
    if (url.pathname === "/api/search" && request.method === "POST") {
      const { query } = await request.json();
      if (!query) return json({ hits: [] });
      // The specialist first, when one is installed: a SEARCH binding can be
      // swapped or upgraded without touching this file. No binding, or a bad
      // answer, falls through to the SearXNG path exactly as before.
      const searchService = this.env.SEARCH;
      if (searchService && typeof searchService.fetch === "function") {
        try {
          const forwarded = await searchService.fetch(new Request("https://search/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query })
          }));
          const body = await forwarded.json().catch(() => null);
          if (forwarded.ok && body && Array.isArray(body.hits)) {
            return json({ hits: body.hits, query, source: "search-specialist", backend: body.backend || "binding:SEARCH" });
          }
        } catch (e) {
        }
      }
      try {
        const result = await searxSearch(this.env, query);
        return json({ hits: result.hits, query, source: "searxng", backend: result.backend });
      } catch (e) {
        return json({ hits: [], error: e && e.message ? e.message : "Search failed" }, e && e.timeout ? 504 : 502);
      }
    }
    if (url.pathname === "/api/classify" && request.method === "POST") {
      const { cardId, content } = await request.json();
      if (!content) return json({ classification: { domain: "general", principles: [] } });
      try {
        const nsmMsgs3 = [
          { role: "system", content: "You are a domain classification engine. Given content, determine: 1) the primary domain (legal, educational, medical, technical, general), 2) propose 2-3 governing principles that should apply to this content. Return JSON with { domain, principles: [{ text, domainTag }] }." },
          { role: "user", content: `Classify this content and propose governing principles:

${content.slice(0, 2e3)}` }
        ];
        const nsm3 = this.getNSM();
        const nsmW3 = nsm3 ? await nsm3.wrap(nsmMsgs3, "classify", { domain: content?.domain }) : { messages: nsmMsgs3, metadata: null };
        const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: nsmW3.messages,
          max_tokens: 512
        });
        const text = aiResponse.response ?? "";
        if (nsm3 && text && nsmW3.metadata) await nsm3.postProcess(text, nsmW3.metadata.domain, "classify");
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const classification = JSON.parse(jsonMatch[0]);
          classification.principles = (classification.principles || []).map((p) => ({
            id: "princ_proposed_" + crypto.randomUUID(),
            text: p.text,
            domainTag: p.domainTag || classification.domain || "general",
            sourceCardId: cardId,
            sourceCitation: "AI proposed from imported content",
            ratificationStatus: "expert",
            confidenceWeight: 0.5
          }));
          return json({ classification });
        }
      } catch {
      }
      return json({ classification: { domain: "general", principles: [] } });
    }
    if (url.pathname === "/api/cards/dock" && request.method === "POST") {
      const { sourceId, targetId, edge } = await request.json();
      const source = this.cards.find((c) => c.id === sourceId);
      const target = this.cards.find((c) => c.id === targetId);
      if (source && target) {
        source.dockedTo = targetId;
        source.dockEdge = edge;
        if (!this.clusters[targetId]) this.clusters[targetId] = [];
        if (!this.clusters[targetId].includes(sourceId)) this.clusters[targetId].push(sourceId);
        await this.persist();
        this.broadcast({ type: "clusters", clusters: this.clusters });
        this.broadcast({ type: "card_updated", card: source });
      }
      return json({ ok: true });
    }
    if (url.pathname === "/api/instruct" && request.method === "POST") {
      const { cardId, instruction, domains } = await request.json();
      if (!instruction) return json({ error: "No instruction provided" }, 400);
      const activePrinciples = this.principles.filter((p) => {
        if (p.domainTag === "universal" || p.domainTag === "ethical") return true;
        return domains && domains.includes(p.domainTag);
      });
      const principleContext = activePrinciples.map((p) => `[${p.domainTag}] ${p.text}`).join("\n");
      const systemPrompt = `You are the NSM Instruct engine. You generate content strictly conditioned on the following ratified principles. Every output must satisfy these principles. If a principle conflicts with the instruction, note the conflict.

Active Principles:
${principleContext || "(none \u2014 general mode)"}`;
      const nsmMsgs4 = [
        { role: "system", content: systemPrompt },
        { role: "user", content: instruction }
      ];
      const nsm4 = this.getNSM();
      const nsmW4 = nsm4 ? await nsm4.wrap(nsmMsgs4, "instruct", { domain: domains?.[0] }) : { messages: nsmMsgs4, metadata: null };
      const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: nsmW4.messages,
        max_tokens: 1024
      });
      const result = aiResponse.response ?? "";
      if (nsm4 && result && nsmW4.metadata) await nsm4.postProcess(result, nsmW4.metadata.domain, "instruct");
      const coverage = activePrinciples.length > 0 ? Math.min(0.85, 0.5 + activePrinciples.length * 0.05) : 0.3;
      return json({ result, confidence: `BASE ${(coverage * 100).toFixed(0)}%`, coverage });
    }
    if (url.pathname === "/api/compliance" && request.method === "POST") {
      const { cardId, content } = await request.json();
      if (!content) return json({ violations: [], suggestions: [] });
      const activePrinciples = this.principles.filter((p) => p.ratificationStatus === "auto" || p.ratificationStatus === "expert");
      if (activePrinciples.length === 0) return json({ violations: [], suggestions: ["No principles ratified yet. Import content to acquire principles."] });
      const principleList = activePrinciples.map((p) => `- [${p.domainTag}/${p.ratificationStatus}] ${p.text}`).join("\n");
      try {
        const nsmMsgs5 = [
          { role: "system", content: `You are a compliance checker. Compare the user's content against these ratified principles. Return JSON: { violations: [strings], suggestions: [strings] }. Violations are hard conflicts. Suggestions are improvements.

Principles:
${principleList}` },
          { role: "user", content: content.slice(0, 3e3) }
        ];
        const nsm5 = this.getNSM();
        const nsmW5 = nsm5 ? await nsm5.wrap(nsmMsgs5, "compliance", {}) : { messages: nsmMsgs5, metadata: null };
        const aiResponse = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: nsmW5.messages,
          max_tokens: 512
        });
        const text = aiResponse.response ?? "";
        if (nsm5 && text && nsmW5.metadata) await nsm5.postProcess(text, nsmW5.metadata.domain, "compliance");
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return json(JSON.parse(jsonMatch[0]));
      } catch {
      }
      return json({ violations: [], suggestions: [] });
    }
    if (url.pathname === "/api/confidence" && request.method === "POST") {
      const { cardId } = await request.json();
      const card = this.cards.find((c) => c.id === cardId);
      if (!card) return json({ error: "Card not found" }, 404);
      const activePrinciples = this.principles.filter((p) => {
        if (p.domainTag === "universal" || p.domainTag === "ethical") return true;
        return card.domains && card.domains.includes(p.domainTag);
      });
      const totalPrinciples = activePrinciples.length;
      const coveredPrinciples = totalPrinciples > 0 ? Math.min(totalPrinciples, Math.floor(card.content.length / 200)) : 0;
      const coverage = totalPrinciples > 0 ? Math.min(0.85, coveredPrinciples / totalPrinciples) : 0.3;
      const hasCitations = (card.content.match(/\[.*?\]\(.*?\)/g) || []).length;
      const integrity = Math.min(0.9, 0.5 + hasCitations * 0.05);
      const conflicts = this.principles.filter(
        (p) => p.ratificationStatus === "auto" && card.content.toLowerCase().includes("not") && p.text.toLowerCase().includes(card.content.toLowerCase().slice(0, 50))
      ).length;
      const consistency = Math.max(0.3, 1 - conflicts * 0.2);
      const base = Math.min(0.85, coverage * 0.4 + integrity * 0.3 + consistency * 0.3);
      const eitlUnlocked = card.eitlStatus === "elevated";
      const total = eitlUnlocked ? Math.min(1, base * 1.3) : base;
      const score = { base, coverage, integrity, consistency, eitlUnlocked, total, gapLog: [] };
      if (eitlUnlocked && card.confidence) {
        score.gapLog.push({ predicted: card.confidence.base, confirmed: total, differential: total - card.confidence.base });
      }
      card.confidence = score;
      await this.persist();
      return json(score);
    }
    if (url.pathname === "/api/eitl/review" && request.method === "POST") {
      const { cardId, action, comment } = await request.json();
      const card = this.cards.find((c) => c.id === cardId);
      if (!card) return json({ error: "Card not found" }, 404);
      card.eitlStatus = action;
      card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (action === "elevate") {
        if (!card.gapLog) card.gapLog = [];
        card.gapLog.push({
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          baseConfidence: card.confidence?.base || 0,
          action,
          comment: comment || ""
        });
      }
      await this.persist();
      this.broadcast({ type: "card_updated", card });
      return json({ ok: true, eitlStatus: action });
    }
    if (url.pathname === "/api/query" && request.method === "POST") {
      await this.ensureLoaded();
      const body = await request.json();
      const { query, domains = ["general"], scope = "all", maxResults = 10 } = body;
      if (!query) return json({ error: "query is required" }, 400);
      const stack = createDomainStack(domains[0] || "general", domains.slice(1));
      const activeDomains = getActiveDomains(stack);
      let allPrinciples = [];
      for (const d of activeDomains) {
        const dm = this.getDomainManager(d);
        if (dm) {
          const cached = await dm.getPrinciples();
          if (cached) {
            allPrinciples.push(...cached.filter((p) => !allPrinciples.find((ep) => ep.id === p.id)));
          }
        }
      }
      if (allPrinciples.length === 0) {
        allPrinciples = this.principles.filter(
          (p) => p.domainTag === "universal" || p.domainTag === "ethical" || activeDomains.includes(p.domainTag)
        );
      }
      let searchCards = this.cards;
      if (scope === "principles") searchCards = [];
      const queryId = "qry_" + crypto.randomUUID();
      const llm = this.getLLM();
      const truth = await this.resolveTruth(query);
      const truthSummary = truth ? {
        id: truth.id || null,
        layer: truth.layer || null,
        source: truth.source || null,
        verified: !!truth.verified,
        provisional: !!truth.provisional,
        confidence: truth?.meta?.confidence ?? null
      } : null;
      let results = [];
      if (truth) {
        results = [{
          sourceType: "truth",
          sourceId: truth.id || queryId,
          domain: stack.primary,
          relevance: 1,
          snippet: truth.answer,
          confidence: { base: truthSummary.confidence ?? 0, total: truthSummary.confidence ?? 0 },
          layer: truthSummary.layer,
          verified: truthSummary.verified,
          provisional: truthSummary.provisional
        }];
      } else if (llm) {
        try {
          results = await llm.deepQuery(query, allPrinciples, searchCards);
        } catch {
        }
      }
      if (results.length === 0) {
        const q = query.toLowerCase();
        results = this.cards.filter(
          (c) => c.title && c.title.toLowerCase().includes(q) || c.content && c.content.toLowerCase().includes(q)
        ).slice(0, maxResults).map((c) => ({
          sourceType: "card",
          sourceId: c.id,
          domain: c.domains?.[0] || "general",
          relevance: 0.5,
          snippet: (c.content || "").slice(0, 200),
          confidence: c.confidence || { base: 0, total: 0 }
        }));
      }
      const coverageScore = allPrinciples.length > 0 ? results.filter((r) => r.sourceType === "principle").length / allPrinciples.length : 0;
      const queryResult = {
        queryId,
        results: results.slice(0, maxResults),
        domainStack: stack,
        principlesApplied: allPrinciples.map((p) => p.id),
        coverageScore: Math.min(coverageScore, 1),
        truth: truthSummary,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      const qDm = this.getDomainManager(stack.primary);
      if (qDm) await qDm.cacheQuery(queryId, queryResult);
      const queryCard = {
        id: "card_" + crypto.randomUUID(),
        type: "Query",
        title: query.slice(0, 60),
        content: query,
        queryText: query,
        queryId,
        domainStack: stack,
        results: queryResult.results,
        truth: queryResult.truth,
        coverageScore: queryResult.coverageScore,
        principlesApplied: queryResult.principlesApplied,
        domains: activeDomains,
        x: 100 + Math.random() * 200,
        y: 100 + Math.random() * 200,
        width: 480,
        height: null,
        dockedTo: null,
        dockEdge: null,
        splitView: false,
        confidence: null,
        eitlStatus: null,
        relationships: [],
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(queryCard);
      await this.persist();
      this.broadcast({ type: "card_created", card: queryCard });
      return json({ ...queryResult, card: queryCard });
    }
    if (url.pathname === "/api/decide" && (request.method === "GET" || request.method === "POST")) {
      // ADMIN_KEY only: this route spends OpenRouter credit on every call and
      // stores the pick, so nothing anonymous reaches it.
      const denied = adminGate(this.env, request);
      if (denied) return denied;
      const now = new Date();
      const hour = decideHourOf(now);
      const stored = await this.ctx.storage.get(DECIDE_BUDGET);
      const budget = stored && stored.hour === hour ? stored : { hour: hour, count: 0 };
      const adopted = (await this.ctx.storage.get(DECIDE_STORE)) || null;
      const cap = { used: budget.count || 0, limit: DECIDE_PER_HOUR, hour: hour };

      if (request.method === "GET") {
        return json({ at: now.toISOString(), models: DECIDE_MODELS, adopted: adopted, budget: cap, traffic: await araTraffic(this.env, 30) });
      }

      const body = await request.json().catch(function () { return {}; });
      const action = String(body.action || "probe").trim();

      if (action === "adopt") {
        const want = String(body.model || "").trim();
        const picked = DECIDE_MODELS.filter(function (m) { return m.id === want; })[0];
        if (!picked) return json({ error: "unknown_model", message: "That is not one of the deciders on the list." }, 400);
        await this.ctx.storage.put(DECIDE_STORE, { model: picked.id, label: picked.label, list: picked.list, at: now.toISOString() });
        return json({ ok: true, adopted: { model: picked.id, label: picked.label, list: picked.list, at: now.toISOString() } });
      }

      if (action === "release") {
        await this.ctx.storage.delete(DECIDE_STORE);
        return json({ ok: true, adopted: null });
      }

      // One ask, every decider. Bounded, because a route that spends money and
      // sits behind one key can still be held down by accident.
      const ask = String(body.ask || "").trim().slice(0, 500);
      if (!ask) return json({ error: "ask_required", message: "Send the ask to compare on." }, 400);
      if ((budget.count || 0) >= DECIDE_PER_HOUR) {
        return json({ error: "probe_capped", message: "Ten comparisons an hour; the count resets at " + hour + ":00Z.", budget: cap }, 429);
      }
      budget.count = (budget.count || 0) + 1;
      await this.ctx.storage.put(DECIDE_BUDGET, budget);
      const env = this.env;
      const results = await Promise.all(DECIDE_MODELS.map(function (m) { return runDecider(env, m, ask); }));
      const ladder = await ladderView(env, ask);
      return json({
        at: now.toISOString(),
        ask: ask,
        results: results,
        ladder: ladder,
        adopted: adopted,
        budget: { used: budget.count, limit: DECIDE_PER_HOUR, hour: hour },
        traffic: await araTraffic(this.env, 30)
      });
    }
    if (url.pathname === "/api/learn" && (request.method === "GET" || request.method === "POST")) {
      // ADMIN_KEY for the sheet, LEARN_KEY for the tools that read it back.
      const adminKey = String((this.env && this.env.ADMIN_KEY) || "").trim();
      const toolKey = String((this.env && this.env.LEARN_KEY) || "").trim();
      const givenAdmin = String(request.headers.get("x-admin-key") || "").trim();
      const givenTool = String(request.headers.get("x-learn-key") || "").trim();
      if (!adminKey && !toolKey) {
        return json({ error: "learn_not_configured", message: "Set ADMIN_KEY or LEARN_KEY on this Worker." }, 503);
      }
      const allowed = (adminKey && sameKey(givenAdmin, adminKey)) || (toolKey && sameKey(givenTool, toolKey));
      if (!allowed) return json({ error: "key_required", message: "Send x-admin-key (ADMIN_KEY) or x-learn-key (LEARN_KEY)." }, 401);

      const ledger = await loadLedger(this);
      const now = (new Date()).toISOString();

      if (request.method === "GET") {
        const prompt = String(url.searchParams.get("prompt") || "");
        const domain = String(url.searchParams.get("domain") || "");
        if (prompt) {
          const moved = learnTend(ledger, prompt);
          if (moved) await saveLedger(this, ledger);
        }
        const built = learnHint(ledger, prompt, domain);
        const rows = ledger.rows.slice().reverse().slice(0, 60).map((r) => ({
          q: r.q, a: r.a, tier: r.tier || "learned", status: r.status || "active", tool: r.tool || null,
          kept: !!r.kept, hits: r.hits || 0, earned: r.earned || null, fit: r.fit, why: r.why || null, at: r.at || null
        }));
        return json({
          at: now,
          hint: built.hint,
          used: built.picked.map((x) => ({ q: x.r.q, fit: Number(x.m.score.toFixed(2)) })),
          rows: rows,
          counts: learnCounts(ledger),
          domains: Object.keys(ledger.domains)
        });
      }

      const body = await request.json().catch(() => ({}));
      const act = String(body.action || "add").trim();
      const q = String(body.q || "").trim().slice(0, 120);
      const a = String(body.a || "").trim().slice(0, 400);
      const tool = String(body.tool || "tew").trim().toLowerCase().slice(0, 20);
      const source = String(body.source || "him").trim().toLowerCase().slice(0, 20);
      const tierIn = String(body.tier || "").trim().toLowerCase();
      const out = { ok: true, action: act };

      if (act === "add" || act === "edit") {
        if (!q || !a) return json({ error: "q and a are required" }, 400);
        const from = String(body.from || "").trim();
        ledger.rows = ledger.rows.filter((r) => r && r.q !== q && (!from || r.q !== from));
        const twin = ledger.rows.find((r) => r && r.q !== q && learnAlike(String(r.a || ""), a) >= 0.8);
        if (twin) {
          twin.before = String(twin.a || "").slice(0, 300);
          twin.a = a;
          twin.merged = (twin.merged || 0) + 1;
          twin.at = now;
          twin.tool = tool;
        } else {
          ledger.rows.push({
            id: "lr_" + crypto.randomUUID(), q: q, a: a,
            prompt: String(body.prompt || "").slice(0, 160), source: source, tool: tool,
            tier: tierIn || (source === "him" ? "his" : "learned"),
            status: "active", kept: source === "him", hits: 0, at: now
          });
        }
        out.saved = q;
      } else if (act === "keep" || act === "hold") {
        const row = ledger.rows.find((r) => r && r.q === q);
        if (!row) return json({ error: "Nothing stored under that" }, 404);
        if (act === "keep") { row.status = "active"; row.kept = true; row.why = null; }
        else { row.status = "candidate"; row.kept = false; row.why = "held by him"; }
        row.moved = now;
      } else if (act === "remove") {
        const before = ledger.rows.length;
        ledger.rows = ledger.rows.filter((r) => !r || r.q !== q);
        out.removed = before - ledger.rows.length;
      } else if (act === "forget") {
        out.forgot = ledger.rows.length;
        ledger.rows = [];
        ledger.domains = {};
      } else if (act === "rule" || act === "rule-remove") {
        const dom = String(body.domain || "").trim().toLowerCase().slice(0, 40);
        const text = String(body.text || body.a || "").trim().slice(0, 300);
        if (!dom || !text) return json({ error: "domain and text are required" }, 400);
        ledger.domains[dom] = Array.isArray(ledger.domains[dom]) ? ledger.domains[dom] : [];
        if (act === "rule") {
          ledger.domains[dom] = ledger.domains[dom].filter((r) => r && r.text !== text);
          ledger.domains[dom].push({ text: text, at: now, tool: tool });
        } else {
          ledger.domains[dom] = ledger.domains[dom].filter((r) => !r || r.text !== text);
          if (!ledger.domains[dom].length) delete ledger.domains[dom];
        }
      } else if (act === "seed") {
        // Fill the ladder from cods once, so it starts with what he already taught it.
        let res;
        try {
          res = await fetch("https://cods.ai-n.workers.dev/prefs", { signal: AbortSignal.timeout(20000) });
        } catch (err) {
          return json({ error: "cods unreachable: " + String((err && err.message) || err) }, 502);
        }
        if (!res.ok) return json({ error: "cods prefs HTTP " + res.status }, 502);
        const d = await res.json().catch(() => ({}));
        let added = 0;
        for (const x of (Array.isArray(d.learned) ? d.learned : [])) {
          if (!x || !x.q || !x.a) continue;
          if (ledger.rows.some((r) => r && String(r.q || "") === String(x.q))) continue;
          ledger.rows.push({
            id: "lr_" + crypto.randomUUID(),
            q: String(x.q).slice(0, 120), a: String(x.a).slice(0, 400),
            prompt: String(x.prompt || "").slice(0, 160), source: "cods", tool: "cods",
            tier: /^(set|renamed) by him/i.test(String(x.prompt || "")) ? "his" : "learned",
            status: x.status === "candidate" ? "candidate" : "active",
            kept: !!x.kept, hits: Number(x.hits) || 0, at: String(x.at || now)
          });
          added += 1;
        }
        const doms = d.domainRules && typeof d.domainRules === "object" ? d.domainRules : {};
        for (const k of Object.keys(doms)) {
          const list = Array.isArray(doms[k]) ? doms[k] : [];
          ledger.domains[k] = Array.isArray(ledger.domains[k]) ? ledger.domains[k] : [];
          for (const r of list) {
            const text = String((r && r.text) || "").slice(0, 300);
            if (!text) continue;
            if (ledger.domains[k].some((y) => y && y.text === text)) continue;
            ledger.domains[k].push({ text: text, at: String((r && r.at) || now), tool: "cods", eg: Array.isArray(r && r.eg) ? r.eg.slice(0, 3) : [] });
            added += 1;
          }
        }
        out.seeded = added;
      } else {
        return json({ error: "unknown action" }, 400);
      }

      ledger.events.push({ at: now, action: act, tool: tool, q: q.slice(0, 80) });
      await saveLedger(this, ledger);
      out.counts = learnCounts(ledger);
      out.at = now;
      return json(out);
    }
    if (url.pathname === "/api/watch" && (request.method === "GET" || request.method === "PUT")) {
      // Gated and fail-closed: an unset key closes this, it never opens it.
      const denied = adminGate(this.env, request);
      if (denied) return denied;
      if (request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        const list = Array.isArray(body.tools) ? body.tools : null;
        if (!list) return json({ error: "tools must be an array" }, 400);
        const clean = [];
        for (const t of list) {
          const name = String((t && t.name) || "").trim();
          const base = String((t && (t.base || t.url)) || "").trim().replace(/\/$/, "");
          const path = String((t && t.path) || "/health").trim();
          if (!name || !/^https:\/\//.test(base)) return json({ error: "each tool needs a name and an https base" }, 400);
          clean.push({ name: name, base: base, path: path });
        }
        await this.ctx.storage.put("WATCH:tools", clean);
        return json({ saved: clean.length, tools: clean });
      }
      const saved = await this.ctx.storage.get("WATCH:tools");
      const tools = Array.isArray(saved) && saved.length ? saved : WATCH_DEFAULTS;
      const probed = await Promise.all(tools.map((t) => probeTool(t)));
      return json({ at: (new Date()).toISOString(), tools: probed });
    }
    if (url.pathname === "/api/keys" && (request.method === "GET" || request.method === "POST")) {
      // Gated and fail-closed, same as the watchtower it sits in: this lists which
      // service holds which secret, which is reconnaissance, so it is not public.
      // Names and state only, never a value — the map came from `wrangler secret
      // list` and the source that reads each name, and it says "not held here"
      // rather than pretending to check what this Worker cannot reach.
      const denied = adminGate(this.env, request);
      if (denied) return denied;

      const selfOrigin = new URL(request.url).origin;
      // A map nobody re-checked is worse than no map: it reads as verified. The age
      // runs from the last confirmation, so "stale" is a state somebody cleared on
      // purpose, not something that silently ages.
      const MAP_AT = "2026-11-16";
      const CONFIRM_KEY = "KEYS:confirmedAt";
      const confirmedRaw = await this.ctx.storage.get(CONFIRM_KEY);
      const confirmedAt = typeof confirmedRaw === "string" ? confirmedRaw : null;
      const ageDays = (function (iso) {
        const t = iso ? Date.parse(iso) : NaN;
        if (!isFinite(t)) return null;
        return Math.max(0, Math.floor((Date.now() - t) / 864e5));
      })(confirmedAt || MAP_AT + "T00:00:00Z");

      async function keyCheck(keyName, label, target, header, expect) {
        const value = String((this.env && this.env[keyName]) || "");
        const started = Date.now();
        if (!value) return { key: keyName, label: label, held: false, ok: false, status: 0, ms: 0, detail: "not set on this Worker" };
        try {
          const res = await fetch(target, { method: "GET", headers: { [header]: value }, signal: AbortSignal.timeout(8000) });
          const status = res.status;
          const ok = status === expect;
          return {
            key: keyName, label: label, held: true, ok: ok, status: status, ms: Date.now() - started,
            detail: ok ? "opens " + label : (status === 401 ? "rejected — pair is split" : "unexpected " + status)
          };
        } catch (err) {
          return { key: keyName, label: label, held: true, ok: false, status: 0, ms: Date.now() - started, detail: "unreachable: " + String((err && err.message) || err) };
        }
      }
      if (request.method === "POST") {
        const body = await request.json().catch(function () { return {}; });
        if (!body || body.action !== "confirm") return json({ error: "unknown action" }, 400);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await this.ctx.storage.put(CONFIRM_KEY, now);
        return json({ confirmedAt: now, mapAt: MAP_AT });
      }
      const checks = await Promise.all([
        keyCheck.call(this, "ADMIN_KEY", "tew /api/watch", selfOrigin + "/api/watch", "x-admin-key", 200),
        keyCheck.call(this, "ARA_KEY", "ara /recent", "https://ara.ai-n.workers.dev/recent", "x-admin-key", 200),
        keyCheck.call(this, "LEARN_KEY", "tew /api/learn", selfOrigin + "/api/learn", "x-learn-key", 200)
      ]);
      const drift = [];
      for (const name of ["ADMIN_KEY", "LEARN_KEY", "ARA_KEY"]) {
        if (!String((this.env && this.env[name]) || "").length) {
          drift.push({ what: "tew:" + name, why: "the map says this Worker holds it; the binding is empty" });
        }
      }
      for (const c of checks) {
        if (c.held && !c.ok && c.status === 401) {
          drift.push({ what: c.key, why: "the map says this pair matches; the gate answered 401 - split pair or stale map" });
        }
      }
      return json({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        checks: checks,
        tldr: [
          checks.filter(function (c) { return c.ok; }).length + " of " + checks.length + " gates answer with the keys this Worker holds",
          "two shared keys - the ARA key in 3 Workers, the LEARN key in 2. Change each group in one go or both go dark",
          "OpenRouter and Cloudflare values come from the provider. Generating one here breaks spend",
          "seven Workers cannot be checked from here: no Cloudflare token on TEW, on purpose",
          (confirmedAt ? "map confirmed " + ageDays + " day" + (ageDays === 1 ? "" : "s") + " ago" : "map never confirmed, dated " + MAP_AT) + ((ageDays !== null && ageDays > 30) ? " - STALE, re-check and confirm" : ""),
          drift.length ? drift.length + " drift finding" + (drift.length === 1 ? "" : "s") + " above - the map and reality disagree" : "no drift between the map and what this Worker can see"
        ],
        map: {
          at: MAP_AT,
          confirmedAt: confirmedAt,
          ageDays: ageDays,
          stale: ageDays === null || ageDays > 30,
          drift: drift,
          blind: "seven Workers hold secrets this one cannot read - ara, mind, cods, truth, ai-proxy, orproxy, pi-harness-example. Their rows are unverified since the confirmation date; there is no Cloudflare token here on purpose."
        },
        pairs: [
          { need: "tew:ARA_KEY = ara:ADMIN_KEY = mind:ARA_KEY", why: "TEW's ladder writes and decider probe, and mind's reports, all present the same key to ARA" },
          { need: "tew:LEARN_KEY = mind:LEARN_KEY", why: "the shared ladder's read key — mind's is unset, so its ladder read is inert until it is created" }
        ],
        orphans: [
        ],
        misnamed: [
        ],
        cleaned: "2026-11-16 \u2014 deleted cods ADMIN_KEY, KEY, CLOUDFLARE_API_TOKEN; mind KEY; ara CLOUDFLARE _API_KEY; pi-harness SEARING_URL2, each confirmed unread in its deployed script",
        spend: {
          openrouter_on_tew: String((this.env && this.env.OPENROUTER_API_KEY) || "").length > 0,
          note: "with no key here, TEW's generation and decider probe go through ORPROXY"
        },
        services: [
          { service: "tew", secrets: ["ADMIN_KEY", "LEARN_KEY", "ARA_KEY"], reads: "sheet · x-learn-key on /api/learn · x-admin-key out to ARA" },
          { service: "ara", secrets: ["ADMIN_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_ID"], reads: "gate on /feedback /outcome /recent and POST /domains \u00b7 decider spend" },
          { service: "mind", secrets: ["ADMIN_KEY", "ARA_KEY", "CLOUDFLARE_API_TOKEN", "OPENROUTER_API_KEY"], reads: "console gate \u00b7 writes to ARA \u00b7 LEARN_KEY missing" },
          { service: "cods", secrets: ["OPENROUTER_API_KEY"], reads: "model calls" },
          { service: "truth", secrets: ["ADMIN_KEY"], reads: "write and ops paths; TEW does not hold this key" },
          { service: "ai-proxy", secrets: ["OPENROUTER_API_KEY"], reads: "upstream spend" },
          { service: "orproxy", secrets: ["ADMIN_SECRET", "OPENROUTER_API_KEY"], reads: "proxy gate and upstream spend" },
          { service: "pi-harness-example", secrets: ["CLOUDFLARE_API_TOKEN", "OPENROUTER_API_KEY"], reads: "harness generation" }
        ],
        // Three buckets, not seven steps: a key that is shared and must change
        // together, a key a Worker owns alone, and a service key that exists as a
        // copy on every Worker. Anything else is clutter on a phone.
        plan: [
          {
            title: "One key \u2014 change every place that uses it",
            sub: "change all of these together or the calls 401",
            rows: [
              {
                k: "the ARA key", where: "ara: ADMIN_KEY \u00b7 tew: ARA_KEY \u00b7 mind: ARA_KEY",
                cmd: "NEW=$(python3 -c \"import secrets;print(secrets.token_urlsafe(32))\"); for w in ara tew mind; do n=ADMIN_KEY; [ $w != ara ] && n=ARA_KEY; printf '%s' \"$NEW\" | npx wrangler@4 secret put $n --name $w; done"
              },
              {
                k: "the LEARN key", where: "tew: LEARN_KEY \u00b7 mind: LEARN_KEY  (mind's does not exist yet \u2014 create it)",
                cmd: "NEW=$(python3 -c \"import secrets;print(secrets.token_urlsafe(32))\"); for w in tew mind; do printf '%s' \"$NEW\" | npx wrangler@4 secret put LEARN_KEY --name $w; done"
              }
            ]
          },
          {
            title: "Own key \u2014 rotate each one alone",
            sub: "nothing else reads these; no pairing, any order",
            cmd: "python3 -c \"import secrets;print(secrets.token_urlsafe(32))\" | npx wrangler@4 secret put ADMIN_KEY --name tew",
            rows: [
              { k: "ADMIN_KEY", where: "tew" },
              { k: "ADMIN_KEY", where: "mind" },
              { k: "ADMIN_KEY", where: "truth" },
              { k: "ADMIN_SECRET", where: "orproxy" }
            ]
          },
          {
            title: "Same key, every copy",
            sub: "one value from the provider, never generated here \u2014 rotate last, after the new one works",
            cmd: "IFS= read -rs KEY; printf '%s' \"$KEY\" | npx wrangler@4 secret put OPENROUTER_API_KEY --name tew   # paste the provider's new key, then repeat per Worker",
            rows: [
              { k: "OPENROUTER_API_KEY", where: "tew ara mind cods ai-proxy orproxy pi-harness-example" },
              { k: "CLOUDFLARE_API_TOKEN", where: "ara mind cods pi-harness-example + the copy you deploy with" }
            ]
          }
        ]
      });
    }
    if (url.pathname === "/api/compare" && request.method === "POST") {
      // Gated: an unset key closes this, it never opens it.
      const denied = adminGate(this.env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const ask = String(body.ask || body.query || "").trim();
      if (!ask) return json({ error: "ask is required" }, 400);
      const at = (new Date()).toISOString();
      const both = await Promise.all([readMindAsk(ask), readCodsAsk(ask)]);
      return json({ ask, at, mind: both[0], cods: both[1], verdict: compareVerdict(both[0], both[1]) });
    }
    if (url.pathname === "/api/audit" && request.method === "POST") {
      await this.ensureLoaded();
      const body = await request.json();
      const { cardIds = [], auditScope = "compliance", domains, includeSnapshots = true } = body;
      if (cardIds.length === 0) return json({ error: "cardIds is required" }, 400);
      const targetCards = this.cards.filter((c) => cardIds.includes(c.id));
      if (targetCards.length === 0) return json({ error: "No matching cards found" }, 404);
      const auditDomains = domains || [...new Set(targetCards.flatMap((c) => c.domains || ["general"]))];
      const stack = createDomainStack(auditDomains[0] || "general", auditDomains.slice(1));
      const activeDomains = getActiveDomains(stack);
      let allPrinciples = [];
      for (const d of activeDomains) {
        const dm = this.getDomainManager(d);
        if (dm) {
          const cached = await dm.getPrinciples();
          if (cached) allPrinciples.push(...cached.filter((p) => !allPrinciples.find((ep) => ep.id === p.id)));
        }
      }
      if (allPrinciples.length === 0) {
        allPrinciples = this.principles.filter(
          (p) => p.domainTag === "universal" || p.domainTag === "ethical" || activeDomains.includes(p.domainTag)
        );
      }
      const auditId = "aud_" + crypto.randomUUID();
      let auditResult;
      const llm = this.getLLM();
      if (llm && auditScope === "full") {
        try {
          auditResult = await llm.deepAudit(targetCards, allPrinciples, auditScope);
        } catch {
        }
      }
      if (!auditResult) {
        auditResult = { findings: [], principleCoverage: { total: allPrinciples.length, satisfied: 0, violated: 0, unaddressed: allPrinciples.length }, overallConfidence: 0, status: "fail" };
        for (const card of targetCards) {
          for (const principle of allPrinciples) {
            const content = (card.content || "").toLowerCase();
            const pText = principle.text.toLowerCase();
            const words = pText.split(/\s+/).filter((w) => w.length > 3);
            const matched = words.filter((w) => content.includes(w));
            const ratio = words.length > 0 ? matched.length / words.length : 0;
            if (ratio > 0.6) {
              auditResult.principleCoverage.satisfied++;
              auditResult.findings.push({
                cardId: card.id,
                severity: "info",
                principleId: principle.id,
                principleText: principle.text,
                description: `Content aligns with principle`,
                suggestion: "",
                confidence: ratio
              });
            } else if (ratio > 0.2) {
              auditResult.principleCoverage.violated++;
              auditResult.findings.push({
                cardId: card.id,
                severity: "warning",
                principleId: principle.id,
                principleText: principle.text,
                description: `Partial alignment with principle \u2014 may need strengthening`,
                suggestion: `Consider expanding content to better address: ${principle.text}`,
                confidence: ratio
              });
            } else {
              auditResult.principleCoverage.unaddressed++;
              auditResult.findings.push({
                cardId: card.id,
                severity: "info",
                principleId: principle.id,
                principleText: principle.text,
                description: `Content does not address this principle`,
                suggestion: `Content may need sections addressing: ${principle.text}`,
                confidence: ratio
              });
            }
          }
        }
        const total = auditResult.principleCoverage.total || 1;
        auditResult.overallConfidence = auditResult.principleCoverage.satisfied / total;
        auditResult.status = auditResult.overallConfidence > 0.7 ? "pass" : auditResult.overallConfidence > 0.4 ? "conditional" : "fail";
      }
      const snapshots = [];
      if (includeSnapshots) {
        for (const card of targetCards) {
          const dm = this.getDomainManager(stack.primary);
          if (dm) {
            const key = await dm.storeSnapshot(card.id, JSON.stringify(card));
            if (key) snapshots.push(key);
          }
        }
      }
      const auditRecord = {
        auditId,
        status: auditResult.status || "fail",
        overallConfidence: auditResult.overallConfidence || 0,
        findings: auditResult.findings || [],
        principleCoverage: auditResult.principleCoverage || { total: 0, satisfied: 0, violated: 0, unaddressed: 0 },
        domainStack: stack,
        snapshots,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      const aDm = this.getDomainManager(stack.primary);
      if (aDm) await aDm.cacheAudit(auditId, auditRecord);
      const auditCard = {
        id: "card_" + crypto.randomUUID(),
        type: "Audit",
        title: `Audit: ${targetCards.map((c) => c.title).join(", ").slice(0, 50)}`,
        content: JSON.stringify(auditRecord, null, 2),
        auditId,
        auditScope,
        targetCardIds: cardIds,
        status: auditRecord.status,
        overallConfidence: auditRecord.overallConfidence,
        findings: auditRecord.findings,
        principleCoverage: auditRecord.principleCoverage,
        domainStack: stack,
        snapshots,
        domains: activeDomains,
        x: 100 + Math.random() * 200,
        y: 100 + Math.random() * 200,
        width: 520,
        height: null,
        dockedTo: null,
        dockEdge: null,
        splitView: false,
        confidence: null,
        eitlStatus: null,
        relationships: cardIds,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.cards.push(auditCard);
      await this.persist();
      this.broadcast({ type: "card_created", card: auditCard });
      return json({ ...auditRecord, card: auditCard });
    }
    if (url.pathname === "/api/domains" && request.method === "GET") {
      await this.ensureLoaded();
      const domainStats = [];
      for (const [key, meta] of Object.entries(DOMAINS)) {
        const dm = this.getDomainManager(key);
        const stats = dm ? await dm.getStats() : { principleCount: 0, assetCount: 0 };
        const stack = this.domainStacks[key] || null;
        domainStats.push({
          id: key,
          ...meta,
          principleCount: stats.principleCount + this.principles.filter((p) => p.domainTag === key).length,
          assetCount: stats.assetCount,
          activeStack: stack
        });
      }
      return json({ domains: domainStats });
    }
    const domainAssetsMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/assets$/);
    if (domainAssetsMatch && request.method === "GET") {
      const domain = domainAssetsMatch[1];
      if (!DOMAINS[domain]) return json({ error: "Invalid domain" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV/R2 not configured" }, 500);
      const assets = await dm.listAssets();
      return json({ domain, assets: assets.map((a) => ({ key: a.key, size: a.size, uploaded: a.uploaded })) });
    }
    if (domainAssetsMatch && request.method === "POST") {
      const domain = domainAssetsMatch[1];
      if (!DOMAINS[domain]) return json({ error: "Invalid domain" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV/R2 not configured" }, 500);
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) return json({ error: "No file provided" }, 400);
      const bytes = await file.arrayBuffer();
      const key = await dm.storeImport(crypto.randomUUID(), file.name, bytes, file.type || "application/octet-stream");
      return json({ ok: true, key, filename: file.name });
    }
    const domainTemplateMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/templates\/([^/]+)$/);
    if (domainTemplateMatch && request.method === "GET") {
      const domain = domainTemplateMatch[1];
      const templateId = domainTemplateMatch[2];
      if (!DOMAINS[domain]) return json({ error: "Invalid domain" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV/R2 not configured" }, 500);
      const template = await dm.getTemplate(templateId);
      if (!template) return json({ error: "Template not found" }, 404);
      return json({ domain, templateId, content: await template.text() });
    }
    if (url.pathname === "/api/domains/stack" && request.method === "POST") {
      await this.ensureLoaded();
      const { primary = "general", secondary = [], sourceCardId } = await request.json();
      const stack = createDomainStack(primary, secondary, sourceCardId);
      this.domainStacks[stack.primary] = stack;
      await this.persist();
      const dm = this.getDomainManager(stack.primary);
      if (dm) await dm.setStack(stack);
      return json({ stack });
    }
    if (url.pathname === "/api/domains/stack" && request.method === "GET") {
      await this.ensureLoaded();
      const domain = url.searchParams.get("domain") || "general";
      const stack = this.domainStacks[domain] || createDomainStack(domain);
      return json({ stack });
    }
    if (url.pathname === "/api/domains/sync" && request.method === "POST") {
      await this.ensureLoaded();
      const { domain } = await request.json();
      if (!domain || !DOMAINS[domain]) return json({ error: "Valid domain required" }, 400);
      const dm = this.getDomainManager(domain);
      if (!dm) return json({ error: "KV not configured" }, 500);
      const domainPrinciples = this.principles.filter(
        (p) => p.domainTag === "universal" || p.domainTag === "ethical" || p.domainTag === domain
      );
      await dm.syncPrinciples(domainPrinciples);
      return json({ ok: true, synced: domainPrinciples.length, domain });
    }
    // ── EITL Sync: pull audits from AUDITS_KV into DO cards ──
    if (url.pathname === "/api/sync" && request.method === "GET") {
      await this.ensureLoaded();
      let synced = 0;
      const newCards = [];
      // Pull audits from AUDITS_KV
      if (this.env.AUDITS_KV) {
        try {
          const auditList = await this.env.AUDITS_KV.list({ prefix: "audit:" });
          for (const key of auditList.keys) {
            const existing = this.cards.find(c => c.auditId === key.name.replace("audit:", ""));
            if (!existing) {
              const data = await this.env.AUDITS_KV.get(key.name, { type: "json" });
              if (data) {
                const card = {
                  id: "card_" + crypto.randomUUID(),
                  type: "Audit",
                  title: (data.type || "audit") + " — " + (data.id || key.name),
                  content: data.lastResponse || data.rawText || JSON.stringify(data.messages || []),
                  auditId: data.id || key.name.replace("audit:", ""),
                  auditScope: data.type || "docket",
                  status: "completed",
                  overallConfidence: data.overallConfidence || 0.5,
                  findings: [],
                  principleCoverage: null,
                  domains: ["legal"],
                  confidence: null,
                  eitlStatus: null,
                  relationships: [],
                  x: 100 + Math.random() * 200,
                  y: 100 + Math.random() * 200,
                  width: 520,
                  height: null,
                  dockedTo: null,
                  dockEdge: null,
                  splitView: false,
                  createdAt: data.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
                  updatedAt: data.updatedAt || data.createdAt || (/* @__PURE__ */ new Date()).toISOString()
                };
                this.cards.push(card);
                newCards.push(card);
                synced++;
              }
            }
          }
        } catch (e) {
          console.error("Audit sync error:", e.message);
        }
      }
      // Pull context memories from CONTEXT_KV
      if (this.env.CONTEXT_KV) {
        try {
          const ctxList = await this.env.CONTEXT_KV.list({ prefix: "ctx:" });
          for (const key of ctxList.keys) {
            if (!key.name.endsWith(":data")) continue;
            const contextId = key.name.replace("ctx:", "").replace(":data", "");
            const existing = this.cards.find(c => c.source === "context:" + contextId);
            if (!existing) {
              const data = await this.env.CONTEXT_KV.get(key.name, { type: "json" });
              if (data && Array.isArray(data) && data.length > 0) {
                const content = data.map(m => m.content || "").join("\n\n").slice(0, 4000);
                const card = {
                  id: "card_" + crypto.randomUUID(),
                  type: "Query",
                  title: "Context: " + contextId,
                  content,
                  queryText: content.slice(0, 200),
                  source: "context:" + contextId,
                  domains: ["general"],
                  confidence: null,
                  eitlStatus: null,
                  relationships: [],
                  x: 100 + Math.random() * 200,
                  y: 100 + Math.random() * 200,
                  width: 480,
                  height: null,
                  dockedTo: null,
                  dockEdge: null,
                  splitView: false,
                  createdAt: (/* @__PURE__ */ new Date()).toISOString(),
                  updatedAt: (/* @__PURE__ */ new Date()).toISOString()
                };
                this.cards.push(card);
                newCards.push(card);
                synced++;
              }
            }
          }
        } catch (e) {
          console.error("Context sync error:", e.message);
        }
      }
      if (synced > 0) {
        await this.persist();
        for (const card of newCards) {
          this.broadcast({ type: "card_created", card });
        }
      }
      return json({ synced, cards: newCards });
    }
    // ── EITL Elevate: revise content, bump confidence, write to master truths ──
    if (url.pathname === "/api/kv/all" && request.method === "GET") {
      const entries = [];
      const kvBindings = [
        { name: "KV_NAMESPACES", kv: this.env.KV_NAMESPACES },
        { name: "ORP_KV", kv: this.env.ORP_KV },
        { name: "AUDITS_KV", kv: this.env.AUDITS_KV },
        { name: "CONTEXT_KV", kv: this.env.CONTEXT_KV }
      ];
      for (const binding of kvBindings) {
        if (!binding.kv) continue;
        try {
          const list = await binding.kv.list({ limit: 100 });
          for (const key of list.keys) {
            const val = await binding.kv.get(key.name, { type: "json" });
            entries.push({
              id: binding.name + ":" + key.name,
              ns: binding.name,
              key: key.name,
              value: val,
              type: typeof val === "object" && val !== null ? (Array.isArray(val) ? "array" : "object") : typeof val
            });
          }
        } catch (e) {
          console.error("KV list error for " + binding.name + ":", e.message);
        }
      }
      return json({ entries });
    }
    if (url.pathname === "/api/elevate" && request.method === "POST") {
      await this.ensureLoaded();
      const { cardId, revisedContent, confidence, title } = await request.json();
      const card = this.cards.find((c) => c.id === cardId);
      if (!card) return json({ error: "Card not found" }, 404);
      // Update card
      if (revisedContent !== void 0) card.content = revisedContent;
      if (title !== void 0) card.title = title;
      if (confidence !== void 0) card.confidence = { base: confidence, total: confidence, coverage: confidence, integrity: confidence, consistency: confidence, eitlUnlocked: true, gapLog: [] };
      card.eitlStatus = "elevated";
      card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (!card.gapLog) card.gapLog = [];
      card.gapLog.push({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        action: "elevate",
        baseConfidence: card.confidence?.base || 0,
        newConfidence: confidence || 0,
        comment: "Elevated to master truth"
      });
      // Write to ORP_KV master truths
      if (this.env.ORP_KV) {
        try {
          const raw = await this.env.ORP_KV.get("master:all", { type: "json" });
          const knowledge = raw || { entries: [] };
          const entry = {
            id: "k_" + Date.now(),
            title: card.title || "Elevated truth",
            content: card.content,
            embedding: [],
            source: "eitl_elevate",
            auditId: card.auditId || null,
            createdAt: (/* @__PURE__ */ new Date()).toISOString(),
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          };
          knowledge.entries.push(entry);
          await this.env.ORP_KV.put("master:all", JSON.stringify(knowledge));
        } catch (e) {
          console.error("ORP_KV write failed:", e.message);
        }
      }
      await this.persist();
      this.broadcast({ type: "card_updated", card });
      return json({ ok: true, card, elevated: true });
    }
    // ── NSM: list acquired domains ──
    if (url.pathname === "/api/nsm/domains" && request.method === "GET") {
      const nsm = this.getNSM();
      const domains = await nsm.listDomains();
      return json({ domains });
    }
    // ── NSM: create/acquire domain ──
    if (url.pathname === "/api/nsm/domains" && request.method === "POST") {
      const { domain, principles } = await request.json();
      if (!domain) return json({ error: "domain required" }, 400);
      const nsm = this.getNSM();
      await nsm.acquireDomain(domain, principles || []);
      return json({ ok: true, domain });
    }
    // ── NSM: get domain patterns ──
    const nsmDomainMatch = url.pathname.match(/^\/api\/nsm\/domains\/([^/]+)$/);
    if (nsmDomainMatch && request.method === "GET") {
      const domain = nsmDomainMatch[1];
      const nsm = this.getNSM();
      const patterns = await nsm.getDomainPatterns(domain);
      const principles = await nsm.getDomainPrinciples(domain);
      const confidence = await nsm.getDomainConfidence(domain);
      const recall = await nsm.getRecallLog(domain);
      return json({ domain, patterns, principles, confidence, recall });
    }
    // ── NSM: add patterns to domain ──
    if (nsmDomainMatch && request.method === "POST") {
      const domain = nsmDomainMatch[1];
      const { patterns } = await request.json();
      const nsm = this.getNSM();
      const existing = await nsm.getDomainPatterns(domain);
      const merged = [...existing];
      for (const p of (patterns || [])) {
        if (!merged.some(e => e.value === p.value)) merged.push(p);
      }
      await nsm.putDomainPatterns(domain, merged);
      return json({ ok: true, domain, patternCount: merged.length });
    }
    // ── NSM: recall log ──
    if (url.pathname === "/api/nsm/recall" && request.method === "GET") {
      const nsm = this.getNSM();
      const idx = await nsm.getDomainIndex();
      const all = {};
      for (const d of idx.domains) {
        all[d] = await nsm.getRecallLog(d);
      }
      return json({ recall: all });
    }
    return json({ error: "Not found" }, 404);
  }
  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    const clientId = attachment?.clientId ?? "unknown";
    try {
      const data = JSON.parse(message);
      switch (data.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "cursor":
          this.broadcast({ type: "cursor", x: data.x, y: data.y, cardId: data.cardId, clientId });
          break;
        case "card:dock":
          if (data.sourceId && data.targetId && data.edge) {
            const source = this.cards.find((c) => c.id === data.sourceId);
            if (source) {
              source.dockedTo = data.targetId;
              source.dockEdge = data.edge;
              if (!this.clusters[data.targetId]) this.clusters[data.targetId] = [];
              if (!this.clusters[data.targetId].includes(data.sourceId)) this.clusters[data.targetId].push(data.sourceId);
              await this.persist();
              this.broadcast({ type: "clusters", clusters: this.clusters });
              this.broadcast({ type: "card_updated", card: source });
            }
          }
          break;
      }
    } catch {
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    ws.close(code, reason);
    this.broadcastPresence();
  }
  async webSocketError(ws, error) {
    console.error("WebSocket error:", error);
  }
};
async function parsePage(html, sourceUrl) {
  let title = sourceUrl;
  let content = "";
  const base = new URL(sourceUrl);
  const rewriter = new HTMLRewriter().on("title", {
    text(t) {
      title += t.text;
      if (t.lastInTextNode) title = title.trim();
    }
  }).on("h1, h2, h3", {
    element(el) {
      content += `

## `;
    },
    text(t) {
      content += t.text;
      if (t.lastInTextNode) content += "\n";
    }
  }).on("p, li, blockquote", {
    element() {
      content += "\n";
    },
    text(t) {
      content += t.text;
      if (t.lastInTextNode) content += "\n";
    }
  }).on("a", {
    element(el) {
      let href = el.getAttribute("href");
      if (href) {
        try {
          href = new URL(href, base).href;
        } catch {
        }
        content += `[${href}] `;
      }
    }
  }).on("img", {
    element(el) {
      let src = el.getAttribute("src");
      if (src) {
        try {
          src = new URL(src, base).href;
        } catch {
        }
        content += `![image](${src}) `;
      }
    }
  }).on("script, style, nav, footer, header, aside", {
    element(el) {
      el.remove();
    }
  });
  const response = new Response(html);
  await rewriter.transform(response).text();
  content = content.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim().slice(0, 8e3);
  if (!title || title === sourceUrl) title = sourceUrl.replace(/^https?:\/\//, "").split("/")[0];
  return { title, content };
}
function cors() {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return h;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() }
  });
}
export {
  Workspace,
  server_default as default
};



