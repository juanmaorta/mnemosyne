// Reproducible small-corpus calibration for Nomic's search task prefixes.
// Run with `node scripts/calibrate-cosine.mjs` while Ollama serves nomic-embed-text.
const documents = [
  ["router", "The home network uses an Omada access point and an ISP router for DHCP."],
  ["plants", "Rhaphidophora tetrasperma cuttings are rooting in water after pruning."],
  ["invoice", "The freelance invoice for the client was paid by bank transfer in June."],
  ["museum", "The Uffizi Gallery in Florence holds Botticelli's Birth of Venus."],
  ["bread", "Sourdough bread ferments overnight before baking in a Dutch oven."],
  ["doctor", "The appointment with the dermatologist is scheduled for Tuesday morning."],
  ["docker", "The CI build runs the test suite in a Docker container."],
  ["camera", "The camera uses a 35 mm lens and manual exposure for portraits."],
  ["dog", "The dog needs its annual vaccination at the veterinary clinic."],
  ["tax", "The income tax return includes freelance revenue and deductible expenses."],
  ["bicycle", "The bicycle needs new brake pads and a chain before the long ride."],
  ["music", "The amplifier and speakers play music from the network streamer."],
  ["esquejes", "Los esquejes de Rhaphidophora tetrasperma están en agua y ya tienen raíces."],
  ["alquiler", "El contrato de alquiler del piso se renueva en noviembre y la fianza es de dos meses."],
  ["factura", "La factura de consultoría se pagó por transferencia bancaria el 15 de julio."],
  ["dentista", "La próxima cita con el dentista será el viernes a las diez de la mañana."],
  ["biblioteca", "El libro de historia del arte se puede recoger en la biblioteca municipal."],
  ["coche", "El coche necesita cambiar el aceite y revisar los neumáticos antes del viaje."],
];

const positives = [
  ["router", "What device gives out IP addresses on my home network?"],
  ["plants", "How are the tetrasperma cuttings being propagated?"],
  ["invoice", "How did the client pay the freelance invoice?"],
  ["museum", "Which Florence museum has Botticelli's Birth of Venus?"],
  ["bread", "What kind of bread is left to ferment overnight?"],
  ["doctor", "When is the dermatologist appointment?"],
  ["docker", "Where do the CI tests run?"],
  ["camera", "Which lens is used for portraits?"],
  ["dog", "Where does the dog get its annual vaccination?"],
  ["tax", "What is included in the income tax return?"],
  ["bicycle", "What parts should be replaced on the bike?"],
  ["music", "What plays music from the network streamer?"],
  ["esquejes", "¿Dónde están enraizando los esquejes de tetrasperma?"],
  ["alquiler", "¿Cuándo se renueva el alquiler del piso?"],
  ["factura", "¿Cómo se pagó la factura de consultoría?"],
  ["dentista", "¿A qué hora es la cita con el dentista?"],
  ["biblioteca", "¿Dónde puedo recoger el libro de historia del arte?"],
  ["coche", "¿Qué mantenimiento necesita el coche antes del viaje?"],
];

const negatives = [
  "What was the final score of the World Cup match?",
  "What is the recipe for a gin and tonic cocktail?",
  "Which programming language does the Mars rover use?",
  "Where is the nearest train station to the hotel?",
  "What is the exchange rate between yen and dollars?",
  "Who won the parliamentary election in Canada?",
  "How many moons does Saturn have?",
  "What is the deadline for applying for a passport?",
  "When does the next lunar eclipse begin?",
  "What is the price of a Tesla Model 3?",
  "Who wrote the novel The Left Hand of Darkness?",
  "How do I change a password in the banking app?",
  "¿Quién ganó el partido de baloncesto de anoche?",
  "¿Cuántos satélites tiene el planeta Saturno?",
  "¿Qué ingredientes lleva la paella valenciana?",
  "¿Cuál es el precio del billete de tren a Sevilla?",
  "¿Cuándo es el próximo eclipse lunar?",
  "¿Quién escribió Cien años de soledad?",
];

const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const model = process.env.OLLAMA_MODEL ?? "nomic-embed-text";
const floor = Number(process.env.MNEMOSYNE_MIN_COS ?? "0.70");
async function embed(input) {
  const response = await fetch(`${host}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  return (await response.json()).embeddings;
}
function cosine(a, b) {
  let dot = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    a2 += a[i] * a[i];
    b2 += b[i] * b[i];
  }
  return dot / Math.sqrt(a2 * b2);
}
const docVectors = await embed(documents.map(([, body]) => `search_document: ${body}`));
const queryVectors = await embed([...positives.map(([, q]) => q), ...negatives].map((q) => `search_query: ${q}`));
const results = queryVectors.map((vector, i) => {
  const ranked = documents.map(([slug], j) => ({ slug, cos: cosine(vector, docVectors[j]) }))
    .sort((a, b) => b.cos - a.cos);
  const positive = i < positives.length;
  const target = positive ? positives[i][0] : null;
  return { kind: positive ? "positive" : "negative", query: positive ? positives[i][1] : negatives[i - positives.length], target, best: ranked[0], targetCos: positive ? ranked.find((r) => r.slug === target)?.cos : null };
});
for (const r of results) console.log(`${r.kind.padEnd(8)} best=${r.best.cos.toFixed(3)} ${r.best.slug.padEnd(8)} target=${r.target ?? "-"} targetCos=${r.targetCos?.toFixed(3) ?? "-"} ${r.query}`);
const minPositive = Math.min(...results.filter((r) => r.kind === "positive").map((r) => r.targetCos));
const maxNegative = Math.max(...results.filter((r) => r.kind === "negative").map((r) => r.best.cos));
console.log(`model=${model} documents=${documents.length} positives=${positives.length} negatives=${negatives.length}`);
console.log(`min positive target cosine=${minPositive.toFixed(3)}; max negative best cosine=${maxNegative.toFixed(3)}; gap=${(minPositive - maxNegative).toFixed(3)}`);
const falseNegatives = results.filter((r) => r.kind === "positive" && r.targetCos < floor).length;
const falsePositives = results.filter((r) => r.kind === "negative" && r.best.cos >= floor).length;
console.log(`floor=${floor.toFixed(3)} false negatives=${falseNegatives}/${positives.length} false positives=${falsePositives}/${negatives.length}`);
if (falseNegatives > 0 || falsePositives > 0) process.exitCode = 1;
