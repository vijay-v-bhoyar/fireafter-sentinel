import {describe,it,expect} from 'vitest';
import {workerVerificationFailureCode,runFailureMessage} from './run-failure';
describe('fixed recovery descriptions without exception disclosure',()=>{
 it('retains a known capacity failure as a safe stage',()=>{
  expect(workerVerificationFailureCode(new Error('MODEL_CONTEXT_UNSUPPORTED'))).toBe('model_context_unsupported');
  expect(runFailureMessage('model_context_unsupported')).toContain('The source exceeds the configured model context');
 });
 it.each([new Error('synthetic-private-error-example'),new Error('__proto__'),new Error('constructor'),{message:'MODEL_CONTEXT_UNSUPPORTED'},null])('redacts unexpected errors and inherited property names %s',error=>{
  expect(workerVerificationFailureCode(error)).toBe('verification_failed');
  expect(runFailureMessage(error instanceof Error?error.message:'untrusted')).not.toContain('synthetic-private-error-example');
  expect(runFailureMessage(error instanceof Error?error.message:'untrusted')).toContain('The run did not finish');
 });
 it('keeps the conservative budget stop visible',()=>{
  expect(runFailureMessage('provider_budget_stopped')).toContain('Reserved usage remains recorded');
  expect(runFailureMessage('run_budget_stopped')).toContain('usage limit');
 });
});
