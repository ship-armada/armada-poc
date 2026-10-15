// ABOUTME: Google Sheets layer for the crowdfund model: live =ARMADA_* custom functions and the Armada setup menu.
// ABOUTME: Source for the generated sheet/Code.gs; runs on top of the engine and scenario blocks from crowdfund-model.html.

// ---- Google Sheets layer ----
// Custom functions take the Inputs data rows (columns in SCENARIO_HEADER order: name,
// include, hop0_commit, hop1_commit, hop1_invites, hop2_commit, hop2_invites) and recompute
// whenever any input cell changes. Amounts go in and come out as dollars; all math in
// between is the engine's exact integer math. Dollar outputs are exact to 6 decimals.

var ARMADA_INPUT_COLUMNS = 7;

// A single-cell range arrives as a bare value; every function works on a 2D array.
function armadaRowsOf_(inputs) {
  return Array.isArray(inputs) ? inputs : [[inputs]];
}

// Sheet cell → the text a CSV field would hold, so rowFromFields parses both identically.
function armadaCellText_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

// Name, commits and invites all blank. The include column alone does not make a row, so
// pre-filled dropdowns or checkboxes down the sheet don't create phantom participants.
function armadaIsBlank_(fields) {
  return [0, 2, 3, 4, 5, 6].every(function (k) { return fields[k].trim() === ''; });
}

function armadaUsd_(units) {
  return Number(CrowdfundScenario.formatUsdcExact(units));
}

function armadaArm_(armWei) {
  return Number(CrowdfundScenario.formatArmExact(armWei));
}

// Display ratio for the sheet to format as %; both sides fit exactly in a double.
function armadaRatio_(numerator, denominator) {
  return denominator === 0n ? '' : Number(numerator) / Number(denominator);
}

// Parses the input rows and runs the engine. `inputIndex[k]` is the input row of rows[k];
// `issues` carry input-row indexes (null for aggregate issues).
function armadaBuild_(inputs) {
  const rows = [];
  const inputIndex = [];
  const fieldIssues = [];
  armadaRowsOf_(inputs).forEach(function (cells, index) {
    const fields = [];
    for (let k = 0; k < ARMADA_INPUT_COLUMNS; k++) fields.push(armadaCellText_(cells[k]));
    if (armadaIsBlank_(fields)) return;
    const parsed = CrowdfundScenario.rowFromFields(fields);
    parsed.errors.forEach(function (message) {
      fieldIssues.push({ level: 'error', row: index, hop: null, message: message });
    });
    inputIndex.push(index);
    rows.push(parsed.row);
  });

  const built = CrowdfundScenario.buildModel(rows);
  const issues = fieldIssues.concat(built.issues.map(function (issue) {
    return Object.assign({}, issue, { row: issue.row === null ? null : inputIndex[issue.row] });
  }));
  const byInput = new Map();
  built.includedRows.forEach(function (rowIndex, k) {
    byInput.set(inputIndex[rowIndex], built.result.participants[k]);
  });
  return { rows: rows, inputIndex: inputIndex, result: built.result, byInput: byInput, issues: issues };
}

function armadaIssueText_(issue) {
  return (issue.hop === null ? '' : 'hop ' + issue.hop + ': ') + issue.message;
}

/**
 * Per-participant allocation, one output row per input row: committed, accepted at hop 0/1/2,
 * ARM, refund (USDC) and that row's issues. Put it in the first column right of the inputs.
 *
 * @param {A2:G} inputs The Inputs data rows (no header).
 * @return Results aligned with the input rows.
 * @customfunction
 */
function ARMADA_RESULTS(inputs) {
  const model = armadaBuild_(inputs);
  const rowIssues = new Map();
  model.issues.forEach(function (issue) {
    if (issue.row === null) return;
    rowIssues.set(issue.row, (rowIssues.has(issue.row) ? rowIssues.get(issue.row) + '; ' : '') + armadaIssueText_(issue));
  });
  const included = new Set(model.inputIndex);

  return armadaRowsOf_(inputs).map(function (cells, index) {
    const issues = rowIssues.get(index) || '';
    const p = model.byInput.get(index);
    if (!p) {
      return ['', '', '', '', '', '', included.has(index) ? (issues || 'excluded') : ''];
    }
    const accepted = p.hops.map(function (h) { return h ? armadaUsd_(h.allocUsdc) : ''; });
    return [armadaUsd_(p.committed)].concat(accepted, [armadaArm_(p.allocArm), armadaUsd_(p.refundUsdc), issues]);
  });
}

/**
 * Sale outcome if the crowdfund finalized with these commits, as label/value rows.
 *
 * @param {Inputs!A2:G} inputs The Inputs data rows (no header).
 * @return Summary rows.
 * @customfunction
 */
function ARMADA_SUMMARY(inputs) {
  const C = CrowdfundModel.CONSTANTS;
  const r = armadaBuild_(inputs).result;
  const fmt = CrowdfundScenario.formatUsdc;
  let outcome = 'Refund mode';
  if (!r.refundMode) outcome = r.saleSize === C.MAX_SALE ? 'Success: expanded sale' : 'Success: base sale';
  let reason = '';
  if (r.refundReason === 'capped-demand-below-min') {
    reason = 'Capped demand is under the ' + fmt(C.MIN_SALE) + ' minimum raise';
  } else if (r.refundReason === 'allocation-below-min') {
    reason = 'Capped demand passes ' + fmt(C.MIN_SALE) + ', but the hop ceilings only allocate ' +
      fmt(r.hopAllocation.totalAllocUsdc) + ' (under the minimum)';
  }
  const maxArm = (C.MAX_SALE * 10n ** 18n) / C.ARM_PRICE;
  const refunds = r.participants.reduce(function (sum, p) { return sum + p.refundUsdc; }, 0n);
  const participants = r.participants.filter(function (p) { return p.committed > 0n; }).length;
  return [
    ['Outcome', outcome],
    ['Refund reason', reason],
    ['Total committed (USDC)', armadaUsd_(r.totalCommitted)],
    ['Capped demand (USDC)', armadaUsd_(r.cappedDemand)],
    ['Over-cap excess (USDC)', armadaUsd_(r.totalCommitted - r.cappedDemand)],
    ['Sale size (USDC)', r.saleSize === 0n ? '' : armadaUsd_(r.saleSize)],
    ['ARM allocated', armadaArm_(r.totalAllocatedArm)],
    ['ARM unsold (swept to treasury)', armadaArm_(maxArm - r.totalAllocatedArm)],
    ['USDC refunded', armadaUsd_(refunds)],
    ['Net proceeds to treasury (USDC)', armadaUsd_(r.netProceeds)],
    ['Participants', participants],
    ['Hop nodes', r.nodeCount],
    ['Hop table basis', r.hopAllocation ? 'finalize() waterfall' : 'projected at base sale (finalize() refunds before the waterfall)'],
  ];
}

/**
 * Hop breakdown (as on the crowdfund Details page): share of sale, committers, committed,
 * capped demand, effective ceiling, allocated, fill, accepted rate and rollover per hop.
 *
 * @param {Inputs!A2:G} inputs The Inputs data rows (no header).
 * @return Hop table with a header row and a total row.
 * @customfunction
 */
function ARMADA_HOPS(inputs) {
  const C = CrowdfundModel.CONSTANTS;
  const r = armadaBuild_(inputs).result;
  const hops = CrowdfundScenario.displayedHops(r);
  const names = ['Hop 0 (seeds)', 'Hop 1', 'Hop 2'];
  const table = [['Hop', 'Share of sale', 'Committers', 'Committed', 'Capped demand', 'Effective ceiling', 'Allocated', 'Fill', 'Accepted', 'Rolls over']];
  for (let hop = 0; hop < CrowdfundModel.NUM_HOPS; hop++) {
    table.push([
      names[hop],
      Number(CrowdfundScenario.hopShareBps(hop)) / 10000,
      r.uniqueCommitters[hop],
      armadaUsd_(r.perHopCommitted[hop]),
      armadaUsd_(r.perHopCapped[hop]),
      armadaUsd_(hops.ceilings[hop]),
      armadaUsd_(hops.allocs[hop]),
      armadaRatio_(r.perHopCapped[hop], hops.ceilings[hop]),
      armadaRatio_(hops.allocs[hop], r.perHopCapped[hop]),
      hop < 2 ? armadaUsd_(hops.leftovers[hop]) : '',
    ]);
  }
  const saleSize = r.saleSize === 0n ? C.BASE_SALE : r.saleSize;
  table.push([
    'Total', 1, r.nodeCount, armadaUsd_(r.totalCommitted), armadaUsd_(r.cappedDemand), armadaUsd_(saleSize),
    armadaUsd_(hops.totalAllocUsdc), armadaRatio_(r.cappedDemand, saleSize), armadaRatio_(hops.totalAllocUsdc, r.cappedDemand), '',
  ]);
  return table;
}

/**
 * Every issue: inputs the contract would reject, over-cap refunds, and invite-supply warnings.
 *
 * @param {Inputs!A2:G} inputs The Inputs data rows (no header).
 * @param {2} firstRow Sheet row number of the first input row (default 2), for "Row N" labels.
 * @return Rows of level, where, message.
 * @customfunction
 */
function ARMADA_ISSUES(inputs, firstRow) {
  const model = armadaBuild_(inputs);
  const rows = armadaRowsOf_(inputs);
  const start = typeof firstRow === 'number' ? firstRow : 2;
  if (model.issues.length === 0) return [['ok', '', 'No issues']];
  return model.issues.map(function (issue) {
    let where = 'All participants';
    if (issue.row !== null) {
      const name = armadaCellText_(rows[issue.row][0]).trim();
      where = 'Row ' + (start + issue.row) + (name ? ' (' + name + ')' : '');
      if (issue.hop !== null) where += ' · hop ' + issue.hop;
    } else if (issue.hop !== null) {
      where += ' · hop ' + issue.hop;
    }
    return [issue.level, where, issue.message];
  });
}

/**
 * Checks the engine against golden vectors (40 self-filled seeds; a non-exact pro-rata).
 * Shows OK when this sheet computes exactly what the contract would.
 *
 * @return OK or FAIL with details.
 * @customfunction
 */
function ARMADA_SELFTEST() {
  try {
    const U = 1000000n;
    const selfFilled = function () { return { commits: [15000n * U, 12000n * U, 6000n * U], invitesReceived: [1, 3, 6] }; };
    const r = CrowdfundModel.finalize(Array.from({ length: 40 }, selfFilled));
    const proRata = CrowdfundModel.computeNodeAllocation(15000n * U, 15000n * U, 564000n * U, 601000n * U);
    const checks = [
      ['sale size', r.saleSize, 1200000n * U],
      ['total allocated', r.totalAllocUsdc, 1200000n * U],
      ['participant ARM', r.participants[0].allocArm, 30000n * U * 10n ** 12n],
      ['participant refund', r.participants[0].refundUsdc, 3000n * U],
      ['pro-rata floor', proRata.allocUsdc, 14076539101n],
    ];
    const failed = checks.filter(function (c) { return c[1] !== c[2]; });
    if (failed.length > 0) {
      return 'FAIL: ' + failed.map(function (c) { return c[0] + ' = ' + c[1] + ', expected ' + c[2]; }).join('; ');
    }
    return 'OK: engine matches the contract golden vectors';
  } catch (e) {
    return 'FAIL: ' + e;
  }
}

// ---- Setup menu ----

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Armada')
    .addItem('Set up model sheets', 'armadaSetUpSheets')
    .addItem('Run self-test', 'armadaRunSelfTest')
    .addToUi();
}

function armadaRunSelfTest() {
  SpreadsheetApp.getUi().alert(ARMADA_SELFTEST());
}

// Creates (or refreshes) the Inputs and Model tabs: headers, live formulas, formats and the
// include dropdown. Never touches input data rows, so it is safe to rerun.
function armadaSetUpSheets() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const usd = '$#,##0.00####';
  const arm = '#,##0.00####';
  const pct = '0.0%';

  const inputs = spreadsheet.getSheetByName('Inputs') || spreadsheet.insertSheet('Inputs');
  inputs.getRange('A1:G1').setValues([CrowdfundScenario.SCENARIO_HEADER.slice()]).setFontWeight('bold');
  inputs.getRange('I1:O1')
    .setValues([['Committed', 'Accepted hop 0', 'Accepted hop 1', 'Accepted hop 2', 'ARM', 'Refund', 'Issues']])
    .setFontWeight('bold');
  inputs.getRange('I2').setFormula('=ARMADA_RESULTS(A2:G)');
  ['C2:D', 'F2:F', 'I2:L', 'N2:N'].forEach(function (a1) { inputs.getRange(a1).setNumberFormat(usd); });
  inputs.getRange('M2:M').setNumberFormat(arm);
  inputs.getRange('B2:B').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['yes', 'no'], true).setAllowInvalid(false).build()
  );
  inputs.setFrozenRows(1);

  const model = spreadsheet.getSheetByName('Model') || spreadsheet.insertSheet('Model');
  model.getRange('A1').setFormula('=ARMADA_SUMMARY(Inputs!A2:G)');
  ['B3:B6', 'B9:B10'].forEach(function (a1) { model.getRange(a1).setNumberFormat(usd); });
  model.getRange('B7:B8').setNumberFormat(arm);
  model.getRange('A16').setValues([['Hop breakdown']]).setFontWeight('bold');
  model.getRange('A17').setFormula('=ARMADA_HOPS(Inputs!A2:G)');
  model.getRange('A17:J17').setFontWeight('bold');
  model.getRange('B18:B21').setNumberFormat('0.00%');
  model.getRange('D18:G21').setNumberFormat(usd);
  model.getRange('H18:I21').setNumberFormat(pct);
  model.getRange('J18:J21').setNumberFormat(usd);
  model.getRange('A23').setValues([['Issues']]).setFontWeight('bold');
  model.getRange('A24').setFormula('=ARMADA_ISSUES(Inputs!A2:G, 2)');
}
