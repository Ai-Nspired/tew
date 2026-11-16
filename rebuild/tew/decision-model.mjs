// TEW triage decision model.
//
// A pass answers a fixed set of questions about the workspace and returns the
// answers as cards. Nothing writes prose. The card body is the user's.
//
// The words are the workspace's, not this file's. Every question, every answer
// value and the claim word are labels: the ids underneath are stable, so cards
// already written keep working when the words change. Any question the workspace
// adds is asked in the same pass and becomes a card; it does not change the
// header, because the header reads the five below.

const CORE = {
  ask: {
    type: "choice",
    criteria: {
      question: "information is wanted",
      instruct: "a direction is to be followed",
      decide: "a choice is to be made",
      produce: "something is to be written",
      none: ""
    }
  },
  material: {
    type: "choice",
    criteria: {
      document: "a filed document, record or exhibit",
      card: "a card already written in this workspace",
      principle: "a principle stated for this workspace",
      conversation: "only the exchange so far",
      none: ""
    }
  },
  standing: {
    type: "choice",
    criteria: {
      primary: "filed material from the matter itself",
      derived: "an earlier answer or card produced in this workspace",
      principle: "a rule stated by the user for this workspace",
      none: ""
    }
  },
  grounded: { type: "noul" },
  limit: { type: "noul" }
};

export const DEFAULT_LABELS = {
  "question.ask": "What does the ask want done, as it is worded?",
  "question.material": "What in the workspace bears on the ask? Choose the closest thing present.",
  "question.standing": "What is that material, in terms of what it can support?",
  "question.grounded": "Can the ask be answered from the material listed, without going outside the workspace?",
  "question.limit": "Does the matter impose a time limit, a deadline, or a period within which something must be done?",

  "answer.ask.question": "information is wanted",
  "answer.ask.instruct": "a direction is to be followed",
  "answer.ask.decide": "a choice is to be made",
  "answer.ask.produce": "something is to be written",
  "answer.ask.none": "",

  "answer.material.document": "a filed document, record or exhibit",
  "answer.material.card": "a card already written in this workspace",
  "answer.material.principle": "a principle stated for this workspace",
  "answer.material.conversation": "only the exchange so far",
  "answer.material.none": "",

  "answer.standing.primary": "filed material from the matter itself",
  "answer.standing.derived": "an earlier answer or card produced in this workspace",
  "answer.standing.principle": "a rule stated by the user for this workspace",
  "answer.standing.none": "",

  "answer.grounded.yes": "yes",
  "answer.grounded.no": "no",
  "answer.limit.yes": "yes",
  "answer.limit.no": "no",

  "claim.primary": "supported by the record",
  "claim.derived": "supported by an earlier card",
  "claim.principle": "supported by a principle",
  "claim.none": "supported by nothing"
};

// The workspace supplies any of these it wants to change. Unknown keys are kept,
// so a workspace can rename a question this file has never heard of.
export function labelsFrom(ws = {}) {
  return Object.assign({}, DEFAULT_LABELS, ws.labels || {});
}

const label = (labels, key, fallback) =>
  typeof labels[key] === "string" ? labels[key] : fallback === undefined ? key.split(".").pop() : fallback;

// The question set put to the decider: the five core questions with whatever
// wording the workspace uses, then anything it has added. Ids never change.
export function questionsFor(ws = {}) {
  const labels = labelsFrom(ws);
  const out = {};
  for (const id of Object.keys(CORE)) {
    const spec = CORE[id];
    const q = { type: spec.type, instructions: label(labels, "question." + id) };
    if (spec.criteria) {
      q.criteria = {};
      for (const val of Object.keys(spec.criteria)) {
        q.criteria[val] = labels["answer." + id + "." + val] !== undefined
          ? labels["answer." + id + "." + val]
          : spec.criteria[val];
      }
    }
    out[id] = q;
  }
  const extras = Array.isArray(ws.questions) ? ws.questions : [];
  for (const extra of extras) {
    if (!extra || typeof extra.id !== "string" || !extra.id) continue;
    if (out[extra.id]) continue;
    const q = {
      type: extra.type === "noul" ? "noul" : "choice",
      instructions: label(labels, "question." + extra.id, extra.instructions || extra.id)
    };
    if (q.type === "choice") {
      q.criteria = extra.criteria && Object.keys(extra.criteria).length ? extra.criteria : { yes: "", no: "" };
    }
    out[extra.id] = q;
  }
  return out;
}

const choice = (a) => (a && a.answered && a.type === "choice" ? a.choice : null);
const certain = (a) => (a && typeof a.confidence === "number" ? a.confidence : null);
const noul = (a) => (a && typeof a.noul === "number" ? a.noul : null);

export function route(answers, meta = {}) {
  const tokens = meta.tokens || 0;
  const media = !!meta.media;
  const blocked = Object.keys(CORE).filter((n) => !answers[n] || answers[n].answered === false);

  const ask = choice(answers.ask);
  const material = choice(answers.material);
  const standing = choice(answers.standing);
  const grounded = noul(answers.grounded);
  const limit = noul(answers.limit);

  let claim = standing || "none";
  const reasons = [];

  if (material === "none") {
    claim = "none";
    reasons.push("the workspace holds nothing that bears on the ask");
  } else if (grounded !== null && grounded <= 0.5) {
    claim = "none";
    reasons.push("the material does not answer the ask");
  } else if (standing) {
    reasons.push("the cards are " + claim);
  }

  if (blocked.length) {
    claim = "none";
    reasons.push("unanswered: " + blocked.join(", "));
  }

  const askCertainty = certain(answers.ask);
  let humanFirst = claim === "none";
  if (humanFirst) {
    reasons.push("a person reads before anything is written on these cards");
  } else if (limit !== null && limit > 0.5) {
    humanFirst = true;
    reasons.push("the matter carries a deadline, so a person reads first");
  } else if (askCertainty !== null && askCertainty < 0.5) {
    humanFirst = true;
    reasons.push("what is being asked came back at " + askCertainty.toFixed(2) + ", so a person reads first");
  }

  let pass;
  if (media) pass = "doc";
  else if (tokens > 262144) pass = "doc";
  else if (Object.keys(answers).length > 1) pass = "joint";
  else pass = "flash";

  return {
    pass,
    claim,
    human_first: humanFirst,
    time_bound: limit !== null && limit > 0.5,
    blocked,
    reasons
  };
}

export function cards(answers, decision, meta = {}) {
  const labels = meta.labels || DEFAULT_LABELS;
  const questions = meta.questions || questionsFor(meta);
  const source = meta.selected ? "selected:" + meta.selected : "workspace";
  const out = [];

  for (const id of Object.keys(questions)) {
    const q = questions[id];
    const a = answers[id];
    const refused = !a || a.answered === false;
    const answered = !refused && (a.type === "choice" || a.type === "noul");
    const core = !!CORE[id];

    let answer = null;
    if (answered && a.type === "choice") answer = a.choice;
    if (answered && a.type === "noul") answer = noul(a) > 0.5 ? "yes" : "no";

    const options = q.type === "choice" ? Object.keys(q.criteria || {}) : ["yes", "no"];

    out.push({
      id: "triage:" + id,
      question: q.instructions,
      query: label(labels, "question." + id, q.instructions),
      type: q.type,
      answer,
      answer_label: answer === null ? "" : label(labels, "answer." + id + "." + answer, answer),
      options,
      option_labels: options.map((o) => label(labels, "answer." + id + "." + o, o)),
      certainty: answered ? (a.type === "choice" ? certain(a) : noul(a)) : null,
      claim: core ? decision.claim : null,
      claim_label: core ? label(labels, "claim." + decision.claim, decision.claim) : "",
      source,
      needs: answered ? null : "user",
      body: ""
    });
  }
  return out;
}

export function explain(decision, meta = {}) {
  const labels = meta.labels || DEFAULT_LABELS;
  return (
    "pass " + decision.pass +
    " · " + label(labels, "claim." + decision.claim, decision.claim) +
    " · human first " + (decision.human_first ? "yes" : "no")
  );
}
