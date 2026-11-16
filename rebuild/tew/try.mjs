import { DEFAULT_LABELS, labelsFrom, questionsFor, route, cards, explain } from "./decision-model.mjs";

let pass = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    failed++;
    console.log("  FAIL  " + name + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
}

const A = (extra = {}) =>
  Object.assign(
    {
      ask: { type: "choice", choice: "question", confidence: 0.9, answered: true },
      material: { type: "choice", choice: "document", confidence: 0.9, answered: true },
      standing: { type: "choice", choice: "primary", confidence: 0.9, answered: true },
      grounded: { type: "noul", noul: 0.9, answered: true },
      limit: { type: "noul", noul: 0.1, answered: true }
    },
    extra
  );

// --- the words belong to the workspace ---------------------------------------

const ws = {
  labels: {
    "question.standing": "what is the basis for this",
    "answer.standing.primary": "the record itself",
    "claim.primary": "backed by the record"
  }
};

let qs = questionsFor(ws);
check("a renamed question is put to the decider in the workspace's words",
  qs.standing.instructions === "what is the basis for this", qs.standing.instructions);
check("a renamed value is offered in the workspace's words",
  qs.standing.criteria.primary === "the record itself", qs.standing.criteria);
check("the ids underneath are untouched", Object.keys(qs.standing.criteria).includes("primary"), Object.keys(qs.standing.criteria));
check("questions nobody renamed keep their text",
  qs.ask.instructions === DEFAULT_LABELS["question.ask"], qs.ask.instructions);

let a = A();
let d = route(a);
let cs = cards(a, d, { questions: qs, labels: labelsFrom(ws), selected: "doc-417" });
check("the same answer renders in the workspace's words",
  cs.find((c) => c.id === "triage:standing").answer_label === "the record itself", cs);
check("the answer id is still the id",
  cs.find((c) => c.id === "triage:standing").answer === "primary", cs);
check("the claim is written in the workspace's words",
  cs[0].claim_label === "backed by the record", cs[0].claim_label);
check("the id is what is stored", cs[0].claim === "primary", cs[0].claim);
check("unrenamed answers read as their defaults",
  cs.find((c) => c.id === "triage:material").answer_label === DEFAULT_LABELS["answer.material.document"], cs);

// --- a question the workspace adds -------------------------------------------

const added = {
  questions: [
    { id: "service", type: "noul", instructions: "Has this been served?" },
    { id: "seat", type: "choice", instructions: "Which court sits on it?", criteria: { holden: "", city: "" } }
  ]
};
qs = questionsFor(added);
check("an added question is asked in the same pass", !!qs.service && !!qs.seat, Object.keys(qs));
check("the core questions are still asked", !!qs.ask && !!qs.standing, Object.keys(qs));
check("an added question cannot shadow a core one",
  questionsFor({ questions: [{ id: "ask", type: "noul" }] }).ask.type === "choice", questionsFor({ questions: [{ id: "ask", type: "noul" }] }).ask);

const fresh = Object.assign({}, A(), { service: { type: "noul", noul: 0.97, answered: true },
                                        seat: { type: "choice", choice: "holden", confidence: 0.8, answered: true } });
cs = cards(fresh, route(fresh), { questions: qs, labels: DEFAULT_LABELS });
check("an added question becomes a card", cs.length === 7, cs.length);
check("the added card carries its answer", cs.find((c) => c.id === "triage:service").answer === "yes", cs);
check("an added card leaves the header alone", cs.find((c) => c.id === "triage:service").claim === null, cs);

// --- the header still reads the core five ------------------------------------

let dd = route(A({ material: { type: "choice", choice: "none", confidence: 0.97, answered: true },
                   standing: { type: "choice", choice: "none", confidence: 0.97, answered: true } }));
check("an empty workspace supports nothing", dd.claim === "none", dd);
check("a person reads first", dd.human_first === true, dd);
dd = route(A({ limit: { type: "noul", noul: 0.94, answered: true } }));
check("a deadline sends it to a person first", dd.human_first === true && dd.claim === "primary", dd);
dd = route(A({ ask: { type: "choice", choice: "question", confidence: 0.24, answered: true } }));
check("an unreadable ask sends it to a person", dd.human_first === true, dd);
dd = route(A());
check("a grounded ask with no deadline is not held back", dd.human_first === false, dd);
check("a refused core question supports nothing",
  route(A({ material: { type: "refusal", answered: false } })).claim === "none", null);
check("several questions take the joint pass", route(A()).pass === "joint", null);
check("media takes the document pass", route(A(), { media: true }).pass === "doc", null);
check("an oversized workspace takes the document pass", route(A(), { tokens: 300000 }).pass === "doc", null);

console.log("\n" + pass + " passed, " + failed + " failed\n");
if (failed) process.exit(1);

// --- the same workspace state, in two vocabularies ---------------------------

const SHOW = [
  { label: "default words", ws: {} },
  { label: "the workspace's words", ws: { labels: {
      "question.limit": "is there a clock running",
      "answer.limit.yes": "clock running",
      "answer.limit.no": "no clock",
      "answer.material.document": "the filing",
      "claim.primary": "backed by the record"
    } } }
];

const answers = A({ material: { type: "choice", choice: "document", confidence: 0.91, answered: true },
                    standing: { type: "choice", choice: "primary", confidence: 0.94, answered: true },
                    limit: { type: "noul", noul: 0.93, answered: true } });

for (const variant of SHOW) {
  const q = questionsFor(variant.ws);
  const l = labelsFrom(variant.ws);
  const decision = route(answers, {})
  console.log("=== " + variant.label);
  for (const c of cards(answers, decision, { questions: q, labels: l, selected: "doc-417" })) {
    console.log("  " + c.question.slice(0, 46).padEnd(48) + (c.answer_label || "—") + (c.certainty === null ? "" : " (" + Number(c.certainty).toFixed(2) + ")"));
  }
  console.log("  " + explain(decision, { labels: l }) + "\n");
}
