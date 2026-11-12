'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk');
const { buildCertificateRequest, evaluateCertificate, checkCertificate, CERTIFICATE_CHECK_MODEL } = require('../certificate-check');

const LEAVE = { leaveStart: '2026-11-12', leaveEnd: '2026-11-13', today: '2026-11-14' };
const GOOD = {
  is_medical_certificate: true, readable: true, patient_name: 'Ravi Kumar', name_match: 'match',
  issue_date: '2026-11-12', rest_from: '2026-11-12', rest_to: '2026-11-13',
  doctor_or_clinic: 'Dr. S. Iyer', has_signature_or_stamp: true, concerns: '',
};

test('a certificate whose name and dates fit the leave is ok', () => {
  const result = evaluateCertificate(GOOD, LEAVE);
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'Name and dates match the leave.');
  assert.ok(result.findings.every(f => f.ok));
});

test('name problems are flagged', () => {
  assert.match(evaluateCertificate({ ...GOOD, name_match: 'mismatch', patient_name: 'Suresh' }, LEAVE).summary, /doesn't match \("Suresh"\)/);
  assert.match(evaluateCertificate({ ...GOOD, name_match: 'partial', patient_name: 'R. K.' }, LEAVE).summary, /partly matches/);
  assert.match(evaluateCertificate({ ...GOOD, name_match: 'not_found', patient_name: '' }, LEAVE).summary, /No patient name/);
});

test('issue dates are checked against the leave and today', () => {
  const summary = issue => evaluateCertificate({ ...GOOD, issue_date: issue }, LEAVE).summary;
  assert.match(summary('2026-11-20'), /future/);
  assert.match(summary('2026-11-01'), /more than a week before/);
  assert.equal(evaluateCertificate({ ...GOOD, issue_date: '2026-11-05' }, LEAVE).status, 'ok');
  assert.match(evaluateCertificate({ ...GOOD, issue_date: '2026-12-01' }, { ...LEAVE, today: '2026-12-05' }).summary, /two weeks after/);
  assert.match(summary(''), /No date found/);
  assert.match(summary('12/11/2026'), /No date found/);
  assert.match(summary('2026-02-31'), /No date found/);
});

test('the advised rest period has to cover the leave', () => {
  const summary = (from, to) => evaluateCertificate({ ...GOOD, rest_from: from, rest_to: to }, LEAVE).summary;
  assert.equal(evaluateCertificate({ ...GOOD, rest_from: '2026-11-11', rest_to: '2026-11-15' }, LEAVE).status, 'ok');
  assert.match(summary('2026-11-12', '2026-11-12'), /only part of the leave/);
  assert.match(summary('2026-11-01', '2026-11-03'), /doesn't cover/);
  assert.match(summary('', ''), /which days of rest/);
});

test('unreadable, non-medical, unsigned or odd documents are flagged', () => {
  assert.match(evaluateCertificate({ ...GOOD, readable: false }, LEAVE).summary, /sharper photo/);
  assert.match(evaluateCertificate({ ...GOOD, is_medical_certificate: false }, LEAVE).summary, /Doesn't look like a medical certificate/);
  assert.match(evaluateCertificate({ ...GOOD, has_signature_or_stamp: false }, LEAVE).summary, /signature or stamp/);
  assert.match(evaluateCertificate({ ...GOOD, concerns: 'The date looks overwritten.' }, LEAVE).summary, /overwritten/);
});

test('buildCertificateRequest sends an image or a PDF with the leave details', () => {
  const img = buildCertificateRequest({ employeeName: 'Ravi Kumar', ...LEAVE, contentType: 'image/jpeg', dataBase64: 'AAA' });
  assert.equal(img.model, CERTIFICATE_CHECK_MODEL);
  assert.equal(img.output_config.format.type, 'json_schema');
  assert.equal(img.messages[0].content[0].type, 'image');
  assert.equal(img.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.match(img.messages[0].content[1].text, /Ravi Kumar[\s\S]*2026-11-12 to 2026-11-13/);
  const pdf = buildCertificateRequest({ employeeName: 'Ravi', ...LEAVE, contentType: 'application/pdf', dataBase64: 'AAA' });
  assert.equal(pdf.messages[0].content[0].type, 'document');
});

function fakeClient(respond) {
  return { beta: { messages: { create: async params => respond(params) } } };
}

test('checkCertificate parses the structured answer', async () => {
  const client = fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(GOOD) }] }));
  const result = await checkCertificate({ employeeName: 'Ravi Kumar', ...LEAVE, contentType: 'image/png', dataBase64: 'AAA' }, { client });
  assert.equal(result.status, 'ok');
  assert.equal(result.extracted.patient_name, 'Ravi Kumar');
});

test('checkCertificate never throws', async () => {
  const args = { employeeName: 'Ravi', ...LEAVE, contentType: 'image/png', dataBase64: 'AAA' };
  assert.equal((await checkCertificate(args)).status, 'error');
  const refused = await checkCertificate(args, { client: fakeClient(() => ({ stop_reason: 'refusal', content: [] })) });
  assert.equal(refused.status, 'error');
  const garbled = await checkCertificate(args, { client: fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] })) });
  assert.match(garbled.summary, /couldn't be read/);
  const offline = await checkCertificate(args, { client: fakeClient(() => { throw new Anthropic.APIConnectionError({ message: 'down' }); }) });
  assert.equal(offline.status, 'error');
  const boom = await checkCertificate(args, { client: fakeClient(() => { throw new Error('boom'); }) });
  assert.equal(boom.status, 'error');
});
