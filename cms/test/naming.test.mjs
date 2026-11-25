import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTitle, isPhotoName, newPhotoNames, nextNumber, originalName, parsePhotoName, parseWorkFolder, photoExt,
  photoName, renamePlan, retitlePlan, withOriginalNote, workFolderName,
} from '../shared/naming.js';

test('cleanTitle drops characters files cannot have and tidies spaces', () => {
  assert.equal(cleanTitle('  Wat / is: "dit"?  <ja>|\\* '), 'Wat is dit ja');
  assert.equal(cleanTitle('Zand\n  storm'), 'Zand storm');
  assert.equal(cleanTitle('Eind...'), 'Eind');
  assert.equal(cleanTitle(null), '');
});

test('work folders: YYYY - title, and back', () => {
  assert.equal(workFolderName(2024, ' Avond:wind '), '2024 - Avondwind');
  assert.equal(workFolderName(null, 'Avondwind'), 'Avondwind');
  assert.deepEqual(parseWorkFolder('2024 - Avondwind'), { year: 2024, title: 'Avondwind' });
  assert.deepEqual(parseWorkFolder('2024 - 2023 - x'), { year: 2024, title: '2023 - x' });
  assert.deepEqual(parseWorkFolder('buis 3'), { year: null, title: 'buis 3' });
});

test('photo names', () => {
  assert.equal(photoExt('IMG_1.JPEG'), 'jpg');
  assert.equal(photoExt('a.HEIC'), 'heic');
  assert.equal(photoExt('scan', 'image/png'), 'png');
  assert.equal(photoExt('scan'), '');
  assert.equal(photoName('Avondwind', 1, 'jpg'), 'Avondwind - 01.jpg');
  assert.equal(photoName('Avondwind', 100, 'jpg'), 'Avondwind - 100.jpg');
  assert.deepEqual(parsePhotoName('Avondwind - 07.JPG'), { title: 'Avondwind', number: 7, ext: 'jpg' });
  assert.deepEqual(parsePhotoName('A - B - 12.png'), { title: 'A - B', number: 12, ext: 'png' });
  assert.equal(parsePhotoName('IMG_2041.jpg'), null);
  assert.equal(parsePhotoName('Avondwind - 7.jpg'), null, 'one digit is not the scheme');
  assert.equal(isPhotoName('Avondwind - 07.jpg', 'Avondwind'), true);
  assert.equal(isPhotoName('Avondwind - 07.JPG', 'Avondwind'), false);
  assert.equal(isPhotoName('Avondwind - 00.jpg', 'Avondwind'), false);
  assert.equal(isPhotoName('Other - 07.jpg', 'Avondwind'), false);
});

test('next numbers follow the highest of this title only', () => {
  const names = ['T - 01.jpg', 'T - 04.heic', 'U - 09.jpg', 'IMG_9.jpg', 'T - 05.JPG'];
  assert.equal(nextNumber(names, 'T'), 5);
  assert.equal(nextNumber([], 'T'), 1);
  assert.deepEqual(newPhotoNames(names, 'T', [{ name: 'b.JPEG' }, { name: 'a.heic' }, { name: 'x', type: 'image/png' }]),
    ['T - 05.jpg', 'T - 06.heic', 'T - 07.png']);
  assert.deepEqual(newPhotoNames(['T - 99.jpg'], 'T', [{ name: 'a.jpg' }]), ['T - 100.jpg']);
});

test('original name note in the description', () => {
  assert.equal(withOriginalNote('', 'IMG_1.jpg'), 'Original name: IMG_1.jpg');
  assert.equal(withOriginalNote('Studio shot ', 'IMG_1.jpg'), 'Studio shot\nOriginal name: IMG_1.jpg');
  assert.equal(withOriginalNote('Original name: first.jpg', 'second.jpg'), 'Original name: first.jpg', 'kept, never overwritten');
  assert.equal(originalName('x\nOriginal name: IMG 1.jpg'), 'IMG 1.jpg');
  assert.equal(originalName(undefined), null);
});

test('renamePlan: tidy a folder by capture time, then name', () => {
  const files = [
    { id: 'a', name: 'T - 02.jpg' },
    { id: 'b', name: 'IMG_3.JPG', time: '2024:05:02 10:00:00' },
    { id: 'c', name: 'IMG_1.jpg', time: '2024:05:01 10:00:00' },
    { id: 'd', name: 'zz.png' },
    { id: 'e', name: 'aa.heic' },
    { id: 'f', name: 'T - 02.jpg' }, // a second 02
  ];
  assert.deepEqual(renamePlan(files, 'T').map((r) => [r.id, r.name]), [
    ['c', 'T - 03.jpg'], ['b', 'T - 04.jpg'], ['e', 'T - 05.heic'], ['f', 'T - 06.jpg'], ['d', 'T - 07.png'],
  ]);
  assert.deepEqual(renamePlan([{ id: 'a', name: 'T - 01.jpg' }], 'T'), [], 'nothing to do');
});

test('renamePlan with only: just-uploaded photos that clash move up, in upload order', () => {
  const files = [
    { id: 'old', name: 'T - 01.jpg' },
    { id: 'other', name: 'T - 02.jpg' }, // another upload got 02 first
    { id: 'n2', name: 'T - 03.jpg' },
    { id: 'n1', name: 'T - 02.jpg' },
    { id: 'x', name: 'IMG_5.jpg' }, // not ours: left alone
  ];
  assert.deepEqual(renamePlan(files, 'T', { only: ['n1', 'n2'] }).map((r) => [r.id, r.name]), [['n1', 'T - 04.jpg']]);
  assert.deepEqual(renamePlan(files.slice(0, 1), 'T', { only: ['old'] }), []);
});

test('retitlePlan renames only photos of the old title, keeping numbers', () => {
  const files = [
    { id: 'a', name: 'Oud - 01.jpg' },
    { id: 'b', name: 'Oud - 03.heic' },
    { id: 'c', name: 'IMG_1.jpg' },
    { id: 'd', name: 'Nieuw - 03.jpg' },
    { id: 'e', name: 'Oud - 04.jpg' },
  ];
  assert.deepEqual(retitlePlan(files, 'Oud', 'Nieuw').map((r) => [r.id, r.name]), [
    ['a', 'Nieuw - 01.jpg'], ['b', 'Nieuw - 04.heic'], ['e', 'Nieuw - 05.jpg'],
  ]);
  assert.deepEqual(retitlePlan(files, 'Oud', 'Oud'), []);
});
