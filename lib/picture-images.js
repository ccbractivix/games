'use strict';

const STARTER_IMAGES = [
  ['duck-lifeguard', 'Duck on duty', 'A rubber duck lifeguard watching over a tiny pool.'],
  ['pineapple-office', 'Out of office', 'A pineapple wearing sunglasses behind an office desk on the beach.'],
  ['turtle-luggage', 'Travel light', 'A turtle pulling an enormous stack of vacation suitcases.'],
  ['flamingo-buffet', 'Breakfast supervisor', 'A flamingo inspecting a towering stack of pancakes.'],
  ['crab-chair', 'Reserved seating', 'A tiny crab relaxing on an oversized beach chair.'],
  ['penguin-sunscreen', 'Vacation essentials', 'A penguin beside a sunscreen bottle larger than itself.'],
].map(([id, title, alt]) => ({
  id, title, alt, credit: 'Original Resort Games illustration', kind: 'starter', enabled: true,
}));

function imageLibrary(state) {
  return [...STARTER_IMAGES, ...(state.pictureImages || [])].map(image => ({
    ...image, enabled: !(state.disabledPictureImages || []).includes(image.id),
  }));
}

function imageInfo(image) {
  return { id: image.id, title: image.title, alt: image.alt, credit: image.credit,
    url: `/api/picture-images/${encodeURIComponent(image.id)}/file` };
}

module.exports = { STARTER_IMAGES, imageLibrary, imageInfo };
