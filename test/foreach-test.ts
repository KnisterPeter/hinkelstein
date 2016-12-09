import test from 'ava';

import {forEach} from '../src/foreach';

test('forEach should call each given item', async t => {
  let count = 0;

  const result = await forEach(['a', 'b'], task => {
    count++;
    return task;
  });

  t.is(result, 'b');
  t.is(count, 2);
});

test('forEach should stop iterating at falsy result', async t => {
  let count = 0;

  await forEach(['a', 'b'], () => {
    count++;
    return Promise.resolve(false);
  });

  t.is(count, 1);
});
