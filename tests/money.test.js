const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Money = require('../core/money.js');

describe('T00 money utilities (docs/08-test-scenarios.md)', () => {
  test('parseRupees', () => {
    assert.equal(Money.parseRupees('1.25L'), 12500000);
    assert.equal(Money.parseRupees('125k'), 12500000);
    assert.equal(Money.parseRupees('1,25,000'), 12500000);
    assert.equal(Money.parseRupees('Rs 1,250.50'), 125050);
  });

  test('formatPaisa', () => {
    assert.equal(Money.formatPaisa(12500050), 'Rs 125,000.50');
  });

  test('roundHalfEven', () => {
    assert.equal(Money.roundHalfEven(2.5), 2);
    assert.equal(Money.roundHalfEven(3.5), 4);
    assert.equal(Money.roundHalfEven(-2.5), -2);
  });

  test('splitProRata', () => {
    assert.deepEqual(Money.splitProRata(100, [1, 1, 1]), [33, 33, 34]);
    assert.deepEqual(Money.splitProRata(10000000, [10, 20, 6]), [2777778, 5555556, 1666666]);
  });
});

describe('parseRupees edge cases', () => {
  const ok = [
    ['125000', 12500000],
    ['125,000', 12500000],
    ['  Rs. 500 ', 50000],
    ['PKR 500', 50000],
    ['₨500', 50000],
    ['0.5', 50],
    ['.75', 75],
    ['10.', 1000],
    ['1.5 lakh', 15000000],
    ['2 lakhs', 20000000],
    ['3lac', 30000000],
    ['1.25 L', 12500000],
    ['2cr', 2000000000],
    ['1.5 crore', 1500000000],
    ['1.2345678L', 12345678],
    ['12.5K', 1250000],
    ['Rs 10.500', 1050],
    ['-500', -50000],
    ['-Rs 500', -50000],
    ['Rs -500', -50000],
    ['(Rs 1,250.50)', -125050],
    ['0', 0],
    ['-0', 0],
    [1250.5, 125050],
    [125000, 12500000],
  ];
  for (const [input, expected] of ok) {
    test(JSON.stringify(input) + ' -> ' + expected, () => {
      assert.equal(Money.parseRupees(input), expected);
    });
  }

  const bad = ['', '   ', 'abc', 'Rs', '1.2.3', '12x', 'k', '1,250.505', '1.234567891L', '1e5', '--5', '-Rs -500', '(-500)', 'NaN', null, undefined, NaN, Infinity, {}];
  for (const input of bad) {
    test('rejects ' + String(input === '' ? '""' : input), () => {
      assert.throws(() => Money.parseRupees(input), (e) => e.code === 'E_VALIDATION');
    });
  }

  test('never goes through floats: large amounts are exact', () => {
    assert.equal(Money.parseRupees('90,071,992,547,409.91'), 9007199254740991);
    assert.throws(() => Money.parseRupees('90,071,992,547,409.92'), (e) => e.code === 'E_VALIDATION');
  });
});

describe('formatPaisa options', () => {
  test('whole rupees hide .00 by default, show it with decimals ALWAYS', () => {
    assert.equal(Money.formatPaisa(12500000), 'Rs 125,000');
    assert.equal(Money.formatPaisa(12500000, { decimals: 'ALWAYS' }), 'Rs 125,000.00');
  });
  test('small amounts and zero', () => {
    assert.equal(Money.formatPaisa(0), 'Rs 0');
    assert.equal(Money.formatPaisa(5), 'Rs 0.05');
    assert.equal(Money.formatPaisa(99999), 'Rs 999.99');
  });
  test('Indian grouping', () => {
    assert.equal(Money.formatPaisa(12500000, { grouping: 'INDIAN' }), 'Rs 1,25,000');
    assert.equal(Money.formatPaisa(1234567890, { grouping: 'INDIAN' }), 'Rs 1,23,45,678.90');
    assert.equal(Money.formatPaisa(99900, { grouping: 'INDIAN' }), 'Rs 999');
  });
  test('negatives', () => {
    assert.equal(Money.formatPaisa(-125050), '-Rs 1,250.50');
    assert.equal(Money.formatPaisa(-125050, { negative: 'PARENS' }), '(Rs 1,250.50)');
  });
  test('custom symbol', () => {
    assert.equal(Money.formatPaisa(125050, { symbol: '' }), '1,250.50');
  });
  test('round-trips through parseRupees', () => {
    for (const p of [0, 1, 99, 100, 125050, 12500050, -777, 9007199254740991]) {
      assert.equal(Money.parseRupees(Money.formatPaisa(p)), p);
      assert.equal(Money.parseRupees(Money.formatPaisa(p, { grouping: 'INDIAN', negative: 'PARENS' })), p);
    }
  });
  test('rejects non-integer paisa', () => {
    assert.throws(() => Money.formatPaisa(1.5), (e) => e.code === 'E_VALIDATION');
  });
});

describe('toRupeeString', () => {
  test('two decimals, no grouping', () => {
    assert.equal(Money.toRupeeString(125050), '1250.50');
    assert.equal(Money.toRupeeString(5), '0.05');
    assert.equal(Money.toRupeeString(-125000), '-1250.00');
  });
});

describe('roundHalfEven and divRoundHalfEven', () => {
  test('non-ties round to nearest', () => {
    assert.equal(Money.roundHalfEven(2.4), 2);
    assert.equal(Money.roundHalfEven(2.6), 3);
    assert.equal(Money.roundHalfEven(-2.6), -3);
    assert.equal(Money.roundHalfEven(0.5), 0);
    assert.equal(Money.roundHalfEven(1.5), 2);
    assert.ok(Object.is(Money.roundHalfEven(-0.4), 0));
  });
  test('rejects non-finite', () => {
    assert.throws(() => Money.roundHalfEven(NaN));
    assert.throws(() => Money.roundHalfEven('2.5'));
  });
  test('exact integer division with ties to even', () => {
    assert.equal(Money.divRoundHalfEven(5, 2), 2);
    assert.equal(Money.divRoundHalfEven(7, 2), 4);
    assert.equal(Money.divRoundHalfEven(-5, 2), -2);
    assert.equal(Money.divRoundHalfEven(-7, 2), -4);
    assert.equal(Money.divRoundHalfEven(5, -2), -2);
    assert.equal(Money.divRoundHalfEven(10, 3), 3);
    assert.equal(Money.divRoundHalfEven(11, 3), 4);
    assert.equal(Money.divRoundHalfEven(-11, 3), -4);
  });
  test('division by zero and non-integers throw', () => {
    assert.throws(() => Money.divRoundHalfEven(1, 0));
    assert.throws(() => Money.divRoundHalfEven(1.5, 2));
  });
});

describe('applyBps', () => {
  test('tax at 18% (test fixture rate)', () => {
    assert.equal(Money.applyBps(50000000, 1800), 9000000); // T06: 500,000 -> 90,000
    assert.equal(Money.applyBps(10000000, 450), 450000); // T05c: 100,000 at 4.5% -> 4,500
    assert.equal(Money.applyBps(534000, 200), 10680); // T12: 5,340 at 2% -> 106.80
  });
  test('rounds half-even on exact ties', () => {
    assert.equal(Money.applyBps(25, 1000), 2); // 2.5 -> 2
    assert.equal(Money.applyBps(35, 1000), 4); // 3.5 -> 4
    assert.equal(Money.applyBps(-25, 1000), -2);
  });
  test('large amount times rate stays exact (beyond 2^53 intermediate)', () => {
    // 9e15 * 1800 overflows double precision; BigInt keeps it exact.
    assert.equal(Money.applyBps(9000000000000000, 1800), 1620000000000000);
    assert.equal(Money.applyBps(9007199254740991, 1), 900719925474);
  });
  test('rejects fractional input', () => {
    assert.throws(() => Money.applyBps(100.5, 1800), (e) => e.code === 'E_VALIDATION');
    assert.throws(() => Money.applyBps(100, 18.5), (e) => e.code === 'E_VALIDATION');
  });
});

describe('splitProRata', () => {
  test('always sums to the total', () => {
    const cases = [
      [1, [1, 1, 1]],
      [0, [3, 4]],
      [-100, [1, 1, 1]],
      [9007199254740991, [1, 2, 3, 4]],
      [12345, [0.5, 1.25, 3]],
      [4000000, [50000000, 1300000]], // T16: electricity 40,000 split by revenue 500,000 : 13,000
    ];
    for (const [total, weights] of cases) {
      const shares = Money.splitProRata(total, weights);
      assert.equal(shares.reduce((a, b) => a + b, 0), total, JSON.stringify([total, weights]));
      assert.equal(shares.length, weights.length);
      shares.forEach((s) => assert.ok(Number.isSafeInteger(s)));
    }
  });
  test('T16 shared electricity allocation by revenue', () => {
    assert.deepEqual(Money.splitProRata(4000000, [50000000, 1300000]), [3898635, 101365]);
  });
  test('decimal weights are exact', () => {
    assert.deepEqual(Money.splitProRata(100, [0.1, 0.2, 0.7]), [10, 20, 70]);
    assert.deepEqual(Money.splitProRata(100, [1.5, 1.5]), [50, 50]);
  });
  test('zero-weight lines get nothing; residual goes to last positive weight', () => {
    assert.deepEqual(Money.splitProRata(100, [1, 1, 1, 0]), [33, 33, 34, 0]);
    assert.deepEqual(Money.splitProRata(100, [0, 2, 0]), [0, 100, 0]);
  });
  test('rejects bad weights and totals', () => {
    assert.throws(() => Money.splitProRata(100, []));
    assert.throws(() => Money.splitProRata(100, [0, 0]));
    assert.throws(() => Money.splitProRata(100, [1, -1]));
    assert.throws(() => Money.splitProRata(100, [1, NaN]));
    assert.throws(() => Money.splitProRata(100, [1e-10, 1]));
    assert.throws(() => Money.splitProRata(10.5, [1, 1]));
  });
});
