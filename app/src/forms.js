'use strict';

// Phase 2 form engine. Forms are data, not code: a versioned JSON definition
// (form_def table) rendered by the console, so coordinators change option
// lists without a deploy — the pain point vendor-gated form edits cause today.
//
// Versioning contract:
//  - every save creates a NEW version; submitted intakes record the version
//    they were written under, so old records always render against it;
//  - options and fields are retired (hidden from new forms), never deleted —
//    an id that existed in version N must exist in version N+1;
//  - renames are label changes on a stable id, so statistics don't fork.

const db = require('./db');
const profile = require('./profile');

// Profile values are frozen; a seeded schema is a plain copy.
const copy = (v) => JSON.parse(JSON.stringify(v));

const FIELD_TYPES = ['select', 'radio', 'checkbox', 'checkboxes', 'text', 'textarea'];
const OPTION_TYPES = ['select', 'radio', 'checkboxes'];

// The default chat intake, drawn field-for-field from TELL's captured iCarol
// forms. Fields iCarol made workers type but our system
// derives (timestamps, duration, response time, transcript, repeat-caller)
// are deliberately absent. Option lists whose iCarol values are not yet
// captured start with sensible entries a coordinator can edit in place.
// The nationality list, and the organisation's name in the call-back option,
// come from the profile (profiles/<id>.json); the clinical fields do not.
const chatIntake = (p) => ({
  sections: [
    {
      id: 'demographics', title: 'Demographics',
      fields: [
        { id: 'age', type: 'select', label: 'Age', required: true,
          options: [
            { id: '0-12', label: '0-12' }, { id: '13-15', label: '13-15' },
            { id: '16-18', label: '16-18' }, { id: '19-23', label: '19-23' },
            { id: '24-29', label: '24-29' }, { id: '30s', label: '30s' },
            { id: '40s', label: '40s' }, { id: '50s', label: '50s' },
            { id: '60s', label: '60s' }, { id: '70+', label: '70+' },
          ] },
        { id: 'gender_identity', type: 'radio', label: 'Gender identity',
          required: true, other_text: true,
          options: [
            { id: 'female', label: 'Female' }, { id: 'male', label: 'Male' },
            { id: 'transgender', label: 'Transgender' },
            { id: 'nonbinary', label: 'Nonbinary' },
            { id: 'questioning', label: 'Questioning' },
            { id: 'gender_fluid', label: 'Gender Fluid' },
            { id: 'bigender', label: 'Bigender' },
            { id: 'no_answer', label: 'Prefer not to answer' },
          ] },
        { id: 'nationality', type: 'select', label: 'Nationality', required: true,
          options: copy(p.forms.nationalityOptions) },
        { id: 'behalf_of', type: 'select', label: 'Contacting on behalf of',
          options: [
            { id: 'self', label: 'Themselves' },
            { id: 'friend_family', label: 'A friend or family member' },
            { id: 'other', label: 'Other' },
          ] },
      ],
    },
    {
      id: 'issues', title: 'Main concerns',
      fields: [
        { id: 'main_concerns', type: 'checkboxes', label: 'Main concerns / issues',
          required: true, prefill: 'triage.concern',
          options: [
            { id: 'suicide', label: 'Suicide' },
            { id: 'sexual_assault', label: 'Sexual Assault / Rape' },
            { id: 'abuse', label: 'Abuse' },
            { id: 'depression', label: 'Depression' },
            { id: 'anxiety', label: 'Anxiety' },
            { id: 'employment', label: 'Employment / Career' },
            { id: 'mental_health', label: 'Mental Health Concern' },
            { id: 'physical_health', label: 'Physical Health Concern' },
            { id: 'cultural_adjustment', label: 'Cultural Adjustment' },
            { id: 'grief', label: 'Death / Grief' },
            { id: 'so_gi', label: 'Sexual Orientation / Gender Identity' },
            { id: 'eating_disorder', label: 'Eating Disorder' },
            { id: 'substance_abuse', label: 'Substance Abuse' },
            { id: 'self_harm', label: 'Self harm / Non-suicidal self-injury' },
            { id: 'relationship_personal', label: 'Relationship (Personal)' },
            { id: 'relationship_professional', label: 'Relationship (Professional / Academic)' },
            { id: 'bullying', label: 'Bullying / Harassment' },
            { id: 'pregnancy', label: 'Pregnancy' },
            { id: 'stis', label: 'STIs' },
            { id: 'other', label: 'Other' },
          ] },
        { id: 'contributing_factors', type: 'checkboxes', label: 'Contributing factors',
          options: [
            { id: 'depression_mh', label: 'Depression or Mental Health Issue' },
            { id: 'substance_misuse', label: 'Drug or Alcohol Misuse' },
            { id: 'family_history_suicide', label: 'Family History of Suicide' },
            { id: 'financial', label: 'Financial Troubles' },
            { id: 'impulsive', label: 'Impulsive' },
            { id: 'isolation', label: 'Isolation or Loneliness' },
            { id: 'low_self_esteem', label: 'Low Self-Esteem' },
            { id: 'hopelessness', label: 'Hopelessness' },
            { id: 'chronic_stress', label: 'Prolonged Exposure to Unmanageable Stress' },
            { id: 'recent_loss', label: 'Recent Loss' },
            { id: 'breakup', label: 'Relationship Break up' },
            { id: 'sexual_orientation', label: 'Sexual Orientation Issue' },
            { id: 'abuse_victim', label: 'Victim of Abuse in Past or Present' },
            { id: 'past_attempts', label: 'Past suicide attempts' },
            { id: 'self_harm', label: 'Self-harm' },
            { id: 'job_loss', label: 'Job Loss or Employment Issues' },
            { id: 'physical_health', label: 'Physical Health Issue' },
            { id: 'other', label: 'Other' },
          ] },
      ],
    },
    {
      id: 'suicide_assessment', title: 'Mandatory suicide question',
      fields: [
        { id: 'ideation', type: 'select', label: 'Ideation', required: true,
          options: [
            { id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' },
            { id: 'not_asked', label: 'Unable to ask' },
          ] },
        { id: 'intention', type: 'select', label: 'Intention',
          show_if: { ideation: 'yes' },
          options: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] },
        { id: 'plan', type: 'select', label: 'Plan',
          show_if: { intention: 'yes' },
          options: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] },
        { id: 'means', type: 'select', label: 'Means',
          show_if: { plan: 'yes' },
          options: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] },
      ],
    },
    {
      id: 'content', title: 'Conversation',
      fields: [
        { id: 'feelings_content', type: 'textarea', required: true,
          label: "User's feelings and brief content" },
        { id: 'end_state', type: 'select', required: true,
          label: 'Observed emotional state at the end (1 = very upset, 5 = calm)',
          options: [
            { id: '1', label: '1' }, { id: '2', label: '2' }, { id: '3', label: '3' },
            { id: '4', label: '4' }, { id: '5', label: '5' },
          ] },
        { id: 'process', type: 'textarea', required: true,
          label: 'Process of the conversation' },
        { id: 'support_provided', type: 'checkboxes', label: 'Support provided',
          options: [
            { id: 'active_listening', label: 'Active listening' },
            { id: 'validation', label: 'Emotional validation' },
            { id: 'deescalation', label: 'De-escalation of intense emotions' },
            { id: 'self_care', label: 'Self care' },
            { id: 'support_network', label: 'Support network' },
            { id: 'past_coping', label: 'Past coping skills' },
            { id: 'community_resources', label: 'Navigating community resources' },
            { id: 'emergency_escalation', label: 'Emergency escalation (Police / EMS)' },
            { id: 'safety_plan', label: 'Directed user to / explained safety plan' },
            { id: 'call_back', label: `${p.name} (call back / reach out again)` },
            { id: 'other', label: 'Other' },
          ] },
      ],
    },
    {
      id: 'finish', title: 'Finish',
      fields: [
        { id: 'reflection', type: 'textarea', required: true,
          label: 'Your reflection of the conversation' },
        { id: 'supervisor_followup', type: 'select', required: true,
          label: 'Would you like your supervisor to follow up with you about this conversation?',
          options: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] },
        { id: 'highlight', type: 'checkbox',
          label: 'Highlight this contact — other workers should be aware of it' },
      ],
    },
  ],
});

// The pre-chat survey, matched to the survey TELL's live chat actually shows
// visitors (screenshot capture, Sept 2026): prefecture, main concern (+other),
// the suicide question, self-harm, upset scale, age, gender identity (+free
// text), transgender, nationality. Main-concern option ids deliberately match
// the intake's main_concerns ids so answers prefill the worker's form 1:1.
// The nickname stays a dedicated field on the widget (it becomes the alias).
// The first question — where the visitor is — is the profile's region field
// (TELL: the 47 prefectures plus Outside Japan / Prefer not to say).
const preChat = (p) => ({
  sections: [
    {
      id: 'pre_chat', title: 'Pre-Chat',
      fields: [
        copy(p.forms.regionField),
        { id: 'main_concern', type: 'select', label: 'What is your main concern?',
          required: true, other_text: true,
          options: [
            { id: 'suicide', label: 'Suicide' },
            { id: 'sexual_assault', label: 'Sexual Assault / Rape' },
            { id: 'abuse', label: 'Abuse' },
            { id: 'depression', label: 'Depression' },
            { id: 'anxiety', label: 'Anxiety' },
            { id: 'employment', label: 'Employment / Career' },
            { id: 'mental_health', label: 'Mental Health Concern' },
            { id: 'physical_health', label: 'Physical Health Concern' },
            { id: 'cultural_adjustment', label: 'Cultural Adjustment' },
            { id: 'grief', label: 'Death / Grief' },
            { id: 'so_gi', label: 'Sexual Orientation / Gender Identity' },
            { id: 'eating_disorder', label: 'Eating Disorder' },
            { id: 'substance_abuse', label: 'Substance Abuse' },
            { id: 'self_harm', label: 'Self harm' },
            { id: 'relationship_personal', label: 'Relationship (Personal)' },
            { id: 'relationship_professional', label: 'Relationship (Professional / Academic)' },
            { id: 'bullying', label: 'Bullying / Harassment' },
            { id: 'other', label: 'Other' },
          ] },
        { id: 'suicidal_thoughts', type: 'select', required: true,
          label: 'Do you have thoughts of killing yourself?',
          options: [
            { id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' },
            { id: 'no_answer', label: 'Prefer not to say' },
          ] },
        { id: 'self_harm', type: 'select', required: true,
          label: 'Self harming behaviour',
          options: [
            { id: 'none', label: 'No, no such thoughts or behaviour' },
            { id: 'thoughts', label: 'I have thoughts of harming myself' },
            { id: 'recent', label: 'I have recently harmed myself' },
            { id: 'no_answer', label: 'Prefer not to say' },
          ] },
        { id: 'upset_scale', type: 'select', required: true,
          label: 'How upset are you? [Scale of 1-5]',
          options: [
            { id: '1', label: '1- Not Upset' },
            { id: '2', label: '2- A Little Upset' },
            { id: '3', label: '3- Upset' },
            { id: '4', label: '4- Very Upset' },
            { id: '5', label: '5- Extremely Upset' },
          ] },
        { id: 'age', type: 'select', label: 'Age', required: true,
          options: [
            { id: '0-12', label: '0-12' }, { id: '13-15', label: '13-15' },
            { id: '16-18', label: '16-18' }, { id: '19-23', label: '19-23' },
            { id: '24-29', label: '24-29' }, { id: '30s', label: '30s' },
            { id: '40s', label: '40s' }, { id: '50s', label: '50s' },
            { id: '60s', label: '60s' }, { id: '70+', label: '70+' },
          ] },
        { id: 'gender_identity', type: 'checkboxes', label: 'Gender Identity',
          required: true, other_text: true,
          options: [
            { id: 'female', label: 'Female' }, { id: 'male', label: 'Male' },
            { id: 'questioning', label: 'Questioning' },
            { id: 'nonbinary', label: 'Nonbinary' },
            { id: 'gender_fluid', label: 'Gender Fluid' },
            { id: 'bigender', label: 'Bigender' },
            { id: 'no_answer', label: 'Prefer not to answer' },
          ] },
        { id: 'transgender', type: 'radio', label: 'Do you identify as transgender?',
          options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
        { id: 'nationality', type: 'select', label: 'Nationality', required: true,
          options: copy(p.forms.nationalityOptions) },
      ],
    },
  ],
});

function fieldsOf(schema) {
  const out = [];
  for (const s of schema.sections || []) for (const f of s.fields || []) out.push(f);
  return out;
}

// Structural validation, plus the retire-not-delete contract against the
// previous version. Returns null when valid, else an error string.
function validateSchema(schema, previous) {
  if (!schema || !Array.isArray(schema.sections) || !schema.sections.length) {
    return 'schema needs a non-empty sections array';
  }
  const fieldIds = new Set();
  for (const s of schema.sections) {
    if (!s.id || !Array.isArray(s.fields)) return 'each section needs id and fields';
    for (const f of s.fields) {
      if (!f.id || typeof f.id !== 'string') return 'each field needs a string id';
      if (fieldIds.has(f.id)) return `duplicate field id: ${f.id}`;
      fieldIds.add(f.id);
      if (!FIELD_TYPES.includes(f.type)) return `bad field type on ${f.id}: ${f.type}`;
      if (OPTION_TYPES.includes(f.type)) {
        if (!Array.isArray(f.options) || !f.options.length) {
          return `field ${f.id} needs options`;
        }
        const optIds = new Set();
        for (const o of f.options) {
          if (!o.id || typeof o.label !== 'string') {
            return `field ${f.id}: each option needs id and label`;
          }
          if (optIds.has(o.id)) return `field ${f.id}: duplicate option id ${o.id}`;
          optIds.add(o.id);
        }
      }
    }
  }
  if (previous) {
    for (const pf of fieldsOf(previous)) {
      const nf = fieldsOf(schema).find((f) => f.id === pf.id);
      if (!nf) return `field ${pf.id} existed before — retire it (retired: true), don't remove it`;
      for (const po of pf.options || []) {
        if (!(nf.options || []).some((o) => o.id === po.id)) {
          return `option ${pf.id}.${po.id} existed before — retire it, don't remove it`;
        }
      }
    }
  }
  return null;
}

// Seeds for a new database only. A form that already has a version is never
// touched, so changing the profile can't rewrite an existing deployment's forms.
const defaults = (p = profile.profile()) => ({ chat_intake: chatIntake(p), pre_chat: preChat(p) });

async function ensureSeeded() {
  for (const [name, schema] of Object.entries(defaults())) {
    const row = await db.get('SELECT id FROM form_def WHERE name = ? LIMIT 1', [name]);
    if (!row) {
      await db.run(
        'INSERT INTO form_def (name, version, schema_json, created_at) VALUES (?,?,?,?)',
        [name, 1, JSON.stringify(schema), db.now()]);
    }
  }
}

// The caller-facing copy of a form: retired options and fields stripped, so
// the public widget never sees them.
function publicSchema(schema) {
  return {
    sections: schema.sections.map((s) => ({
      ...s,
      fields: (s.fields || []).filter((f) => !f.retired).map((f) => ({
        ...f,
        options: (f.options || []).filter((o) => !o.retired),
      })),
    })),
  };
}

async function currentForm(name) {
  await ensureSeeded();
  const row = await db.get(
    `SELECT * FROM form_def WHERE name = ? ORDER BY version DESC LIMIT 1`, [name]);
  return row ? { name: row.name, version: Number(row.version),
    schema: JSON.parse(row.schema_json) } : null;
}

async function formVersion(name, version) {
  const row = await db.get(
    'SELECT * FROM form_def WHERE name = ? AND version = ?', [name, version]);
  return row ? { name: row.name, version: Number(row.version),
    schema: JSON.parse(row.schema_json) } : null;
}

// Save a new version (coordinator edit). Enforces retire-not-delete against
// the current version.
async function saveNewVersion(name, schema, actorId) {
  const cur = await currentForm(name);
  const err = validateSchema(schema, cur ? cur.schema : null);
  if (err) return { error: err };
  const version = (cur ? cur.version : 0) + 1;
  await db.run(
    'INSERT INTO form_def (name, version, schema_json, created_by, created_at) VALUES (?,?,?,?,?)',
    [name, version, JSON.stringify(schema), actorId, db.now()]);
  await db.audit(actorId, 'form_def_saved', 'form_def', version);
  return { name, version };
}

module.exports = {
  get DEFAULT_CHAT_INTAKE() { return chatIntake(profile.profile()); },
  get DEFAULT_PRE_CHAT() { return preChat(profile.profile()); },
  defaults, validateSchema, ensureSeeded,
  currentForm, formVersion, saveNewVersion, fieldsOf, publicSchema,
};
