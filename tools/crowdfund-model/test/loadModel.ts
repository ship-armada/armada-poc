// ABOUTME: Loads the model's pure script blocks straight out of crowdfund-model.html for testing.
// ABOUTME: Tests run the exact code that ships in the shareable file, so there is no second copy to drift.

import { pureModelSource } from "../modelSource";

export { MODEL_HTML_PATH, extractScriptBlock, readModelHtml } from "../modelSource";

// The blocks are plain browser scripts that declare globals, so they are evaluated in a
// function scope and the globals returned. Result shapes are documented in the HTML.
export function loadModel(): { engine: any; scenario: any } {
  return new Function(`${pureModelSource()}\nreturn { engine: CrowdfundModel, scenario: CrowdfundScenario };`)();
}
