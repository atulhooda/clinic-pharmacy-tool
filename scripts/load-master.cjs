#!/usr/bin/env node
// Load the reviewed medicine_master seed (06a §6.3, R6-5) as pharmacy_curator:
//
//   CURATOR_DATABASE_URL=… node scripts/load-master.cjs
//
// Only files listed in data/master/SOURCES.md are read, and every row must name a listed
// source that has a licence note (06b DG-07). Rows are upserted by (source, source_ref); a
// changed row's version goes up. Rows are loaded unverified. Prints counts only.
'use strict';
const fs = require('fs');
const path = require('path');
const pg = require('pg');

const DIR = path.join(__dirname, '..', 'data', 'master');
const FORMS = ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'INJECTION', 'CREAM', 'OINTMENT', 'GEL', 'LOTION', 'SOLUTION', 'DROPS',
  'POWDER', 'SACHET', 'SPRAY', 'SHAMPOO', 'SOAP', 'SERUM', 'PATCH', 'DEVICE', 'OTHER'];

/** The table in SOURCES.md: [{source, file, licence}]. */
function readSources(dir = DIR) {
  const md = fs.readFileSync(path.join(dir, 'SOURCES.md'), 'utf8');
  const rows = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*`([a-z0-9-]+)`\s*\|\s*`([a-z0-9-]+\.json)`\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (m) rows.push({ source: m[1], file: m[2], licence: m[3] });
  }
  return rows;
}

function readSeed(dir = DIR) {
  const sources = readSources(dir);
  const out = [];
  for (const s of sources) {
    if (!s.licence) throw new Error(`source ${s.source} has no licence note`);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, s.file), 'utf8'));
    for (const r of rows) {
      if (!r.source_ref || !r.brand_name || !r.manufacturer_name || !FORMS.includes(r.dosage_form) || !Array.isArray(r.salts)) {
        throw new Error(`${s.file}: a row is missing a required field (source_ref ${r.source_ref ?? '?'})`);
      }
      out.push({ ...r, source: s.source });
    }
  }
  return out;
}

async function load(url, dir = DIR) {
  const rows = readSeed(dir);
  const c = new pg.Client({ connectionString: url, application_name: 'pharmacy-load-master' });
  await c.connect();
  let inserted = 0;
  let updated = 0;
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      const res = await c.query(
        `INSERT INTO medicine_master (brand_name, manufacturer_name, dosage_form, strength_text, suggested_base_unit, salts,
                                      requires_prescription, source, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         ON CONFLICT (source, source_ref) DO UPDATE
            SET brand_name = EXCLUDED.brand_name, manufacturer_name = EXCLUDED.manufacturer_name, dosage_form = EXCLUDED.dosage_form,
                strength_text = EXCLUDED.strength_text, suggested_base_unit = EXCLUDED.suggested_base_unit, salts = EXCLUDED.salts,
                requires_prescription = EXCLUDED.requires_prescription, version = medicine_master.version + 1, updated_at = now()
          WHERE (medicine_master.brand_name, medicine_master.manufacturer_name, medicine_master.dosage_form, medicine_master.strength_text,
                 medicine_master.suggested_base_unit, medicine_master.salts, medicine_master.requires_prescription)
                IS DISTINCT FROM (EXCLUDED.brand_name, EXCLUDED.manufacturer_name, EXCLUDED.dosage_form, EXCLUDED.strength_text,
                 EXCLUDED.suggested_base_unit, EXCLUDED.salts, EXCLUDED.requires_prescription)
         RETURNING (xmax = 0) AS inserted`,
        [r.brand_name, r.manufacturer_name, r.dosage_form, r.strength_text ?? null, r.suggested_base_unit ?? null,
          JSON.stringify(r.salts), r.requires_prescription === true, r.source, r.source_ref]);
      if (res.rows[0]?.inserted) inserted++; else if (res.rows[0]) updated++;
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
  return { rows: rows.length, inserted, updated };
}

module.exports = { readSources, readSeed, load };

if (require.main === module) {
  const url = process.env.CURATOR_DATABASE_URL;
  if (!url) {
    console.error('[load-master] CURATOR_DATABASE_URL is not set');
    process.exit(1);
  }
  load(url).then((r) => console.log(`[load-master] ${r.rows} rows: ${r.inserted} inserted, ${r.updated} updated`))
    .catch((err) => { console.error(`[load-master] FAILED: ${err.code ?? ''} ${err.message}`); process.exit(1); });
}
