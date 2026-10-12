# Keep native Agent delegation and carry routing metadata in its prompt

The Parent supplies per-Spawn Work Role and Solution Space in a leading `<metadata>` section, followed by the assignment in `<prompt>`. We keep native Agent delegation because the documented mods SDK does not expose native input-schema extension. A separate tool with structured fields could forward to Agent, but plugin-raised calls have different background and result behavior; preserving ordinary delegation is preferable to introducing a wrapper and its compatibility obligations.

Metadata informs Routing rather than constraining model eligibility. Missing or invalid fields fall back to inference from the task, and the original prompt reaches the subagent unchanged. Definitions live in [GLOSSARY.md](../../GLOSSARY.md); the agreed behavior and outcome-validation gate are in the [design notes](../design/solution-space-routing.md).
