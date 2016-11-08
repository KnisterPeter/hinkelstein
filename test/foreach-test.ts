import test from 'ava';

import {forEach} from '../src/foreach';

test('forEach should call each given item', t => {
  let count = 0;
  return forEach(['a', 'b'], task => {
      count++;
      return Promise.resolve(task);
    })
    .then(result => {
      t.is(result, 'b');
      t.is(count, 2);
    });
});

test('forEach should stop iterating at falsy result', t => {
  let count = 0;
  return forEach(['a', 'b'], () => {
      count++;
      return Promise.resolve(false);
    })
    .then(() => {
      t.is(count, 1);
    });
});
