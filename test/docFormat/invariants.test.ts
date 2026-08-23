import { describe, expect, it } from 'vitest';
import { parseInvariantsSection } from '../../src/docFormat/invariants.js';

describe('parseInvariantsSection', () => {
  it('parses a numbered list into sequential id/text pairs', () => {
    const body = [
      '## Business Logic',
      'Some prose.',
      '',
      '## Invariants',
      '1. An order can only be cancelled while its status is pending or on-hold.',
      '2. A discount never exceeds 50% of the item price.',
      '3. A cart cannot contain more than 99 units of a single SKU.',
      '',
      '## Inputs / Outputs',
      'more prose',
    ].join('\n');

    expect(parseInvariantsSection(body, 'Invariants')).toEqual([
      { id: 'I1', text: 'An order can only be cancelled while its status is pending or on-hold.' },
      { id: 'I2', text: 'A discount never exceeds 50% of the item price.' },
      { id: 'I3', text: 'A cart cannot contain more than 99 units of a single SKU.' },
    ]);
  });

  it('returns [] when the heading is absent', () => {
    const body = ['## Purpose', 'hello', '', '## Responsibilities', 'world'].join('\n');
    expect(parseInvariantsSection(body, 'Invariants')).toEqual([]);
  });

  it('returns [] when the heading has no numbered lines beneath it', () => {
    const body = ['## Invariants', '_Pending generation._', '', '## Inputs / Outputs', 'stuff'].join('\n');
    expect(parseInvariantsSection(body, 'Invariants')).toEqual([]);
  });

  it('stops at the next "##" heading rather than swallowing later sections', () => {
    const body = [
      '## Invariants',
      '1. Rule one.',
      '2. Rule two.',
      '## Inputs / Outputs',
      '1. This looks like a list item but belongs to a different section.',
    ].join('\n');

    expect(parseInvariantsSection(body, 'Invariants')).toEqual([
      { id: 'I1', text: 'Rule one.' },
      { id: 'I2', text: 'Rule two.' },
    ]);
  });

  it('stops at an indented "##" heading rather than swallowing it as list content', () => {
    const body = [
      '## Invariants',
      '1. Rule one.',
      '2. Rule two.',
      '  ## Inputs / Outputs',
      '1. This looks like a list item but belongs to a different section.',
    ].join('\n');

    expect(parseInvariantsSection(body, 'Invariants')).toEqual([
      { id: 'I1', text: 'Rule one.' },
      { id: 'I2', text: 'Rule two.' },
    ]);
  });

  it('works for the Ukrainian heading text', () => {
    const body = [
      '## Бізнес-логіка',
      'проза',
      '',
      '## Інваріанти',
      '1. Замовлення можна скасувати лише у статусі "очікує" або "на утриманні".',
      '2. Знижка ніколи не перевищує 50% від ціни товару.',
      '',
      '## Входи / Виходи',
      'прозаa',
    ].join('\n');

    expect(parseInvariantsSection(body, 'Інваріанти')).toEqual([
      { id: 'I1', text: 'Замовлення можна скасувати лише у статусі "очікує" або "на утриманні".' },
      { id: 'I2', text: 'Знижка ніколи не перевищує 50% від ціни товару.' },
    ]);
  });
});
