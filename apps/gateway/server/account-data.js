'use strict';
/**
 * Account export and deletion → Tools (ADR-033; openvibe-sdk/account-data). What Tools holds about a person:
 *
 * - the tool jobs they own (tool_jobs.owner is 'user:usr_…' for a signed-in person): the job they asked for, its
 *   input, its files and its result. That is their own content, so it goes in their export and goes with the
 *   account on a deletion (ADR-033) — with the rows that hang under the job: its event log and its references;
 * - the billing reading of an ended job (tool_job_billing_readings): a money record. The books must still
 *   reconcile, so it stays, with the person in it a tombstone instead of a name;
 * - the usage counts (tool_job_usage), the tool opens (tool_opens_daily) and the domain history (the WHOIS and
 *   RDAP facts, kept per domain): the service's own, counted per project, per tool and per domain, never per
 *   person;
 * - the analytics (analytics_events): the tracker's own rows. Its user_id is a local counter, not a subject, and
 *   the rows are not keyed by a person (the guard's exemption says so);
 * - the guard's abuse log (guard_abuse): an address hash and a service principal, never a person.
 *
 * Telemetry samples that name a person are covered by the SDK itself (telemetry.json, then the subject NULL).
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

// The tables this service answers for. The person's tool jobs are erased together with the rows that hang under
// them (the job's event log, its references), so they are not in the table map: the map deletes the job first and
// those rows would stay behind. The guard (openvibe-sdk/account-data's uncovered) needs the table named, so it is
// in GUARDED below.
const TABLES = [];
const GUARDED = ['tool_jobs'];

// What of a job is the person's to read back: the job, its input, its files and its result.
const JOB_COLUMNS = ['id', 'app', 'type', 'state', 'tool', 'project_id', 'input_json', 'files_json', 'result_json', 'created_at', 'updated_at', 'finished_at'];

// A person's jobs carry their subject as the owner ('user:usr_…'); an app's or a browser session's jobs do not.
const ownerForms = (subjects) => subjects.map((s) => `user:${s}`);

/** The person's jobs, and the billing readings of those jobs. */
async function extraExport(db, subject) {
    const forms = ownerForms([subject]);
    const jobs = await db.many(
        `SELECT ${JOB_COLUMNS.map((c) => `"${c}"`).join(', ')} FROM tool_jobs WHERE owner = ANY($1::text[]) ORDER BY created_at DESC LIMIT 5000`,
        [forms]);
    if (!jobs.length) return [];
    const files = [{ name: 'tool-jobs.json', content: jobs }];
    const readings = await db.many(
        'SELECT job_id, reading, created_at FROM tool_job_billing_readings WHERE job_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 5000',
        [jobs.map((j) => j.id)]);
    if (readings.length) files.push({ name: 'billing-readings.json', content: readings });
    return files;
}

/**
 * The person's jobs go, with the rows that hang under them. The billing reading of a job is a money record: it
 * stays, and the person in it becomes a tombstone (ADR-033).
 */
async function extraErase(t, subjects, counts) {
    const forms = ownerForms(subjects);
    const ids = (await t.many('SELECT id FROM tool_jobs WHERE owner = ANY($1::text[])', [forms])).map((r) => r.id);
    if (!ids.length) return;
    counts.add(counts.erased, 'tool_job_events', await t.exec('DELETE FROM tool_job_events WHERE job_id = ANY($1::text[])', [ids]));
    counts.add(counts.erased, 'tool_job_references', await t.exec('DELETE FROM tool_job_references WHERE job_id = ANY($1::text[])', [ids]));
    counts.add(counts.retained, 'tool_job_billing_readings', await t.exec(
        `UPDATE tool_job_billing_readings SET reading = jsonb_set(reading, '{subject}', '"user:deleted"') WHERE job_id = ANY($1::text[]) AND reading ? 'subject'`, [ids]));
    counts.add(counts.erased, 'tool_jobs', await t.exec('DELETE FROM tool_jobs WHERE id = ANY($1::text[])', [ids]));
}

function create({ db, log = console } = {}) {
    return createAccountData({
        db, service: 'tools', tables: TABLES, extraExport, extraErase, log,
        note: 'Your tool jobs and the results you asked for are deleted. The usage they were billed for stays, without your name.',
    });
}

module.exports = { create, TABLES, GUARDED, TOPICS, extraExport, extraErase };
