'use strict';

const words = require('naughty-words/en.json');
const politicians = require('./political-names.json');

const POLITICAL_TERMS = [
  'president', 'presidents', 'presidential', 'vice president', 'potus', 'prez', 'vp', 'white house', 'oval office',
  'congress', 'congressman', 'congressmen', 'congresswoman', 'congresswomen', 'congressperson',
  'congresspeople', 'congressional', 'senator', 'senators', 'senate',
  'representative', 'representatives', 'governor', 'governors', 'gubernatorial',
  'politician', 'politicians', 'legislator', 'legislators', 'legislature', 'democrat', 'democrats', 'democratic party',
  'republican', 'republicans', 'gop', 'maga', 'desantis', 'trump', 'biden', 'obama',
  'kamala harris', 'jd vance', 'j d vance', 'donalds', 'marco rubio', 'rick scott',
  'jeb bush', 'george bush', 'george w bush', 'bill clinton', 'hillary clinton',
  'charlie crist', 'andrew gillum', 'nancy pelosi', 'aoc', 'bernie sanders',
  ...politicians.names,
];
const TARGETS = [
  'florida', 'floridian', 'floridians', 'sunshine state', 'conservative', 'conservatives',
  'liberal', 'liberals', 'religion', 'religions', 'religious', 'faith', 'church', 'churches',
  'christian', 'christians', 'christianity', 'catholic', 'catholics', 'protestant', 'protestants',
  'baptist', 'baptists', 'evangelical', 'evangelicals', 'muslim', 'muslims', 'islam', 'islamic',
  'jew', 'jews', 'jewish', 'judaism', 'hindu', 'hindus', 'hinduism', 'buddhist', 'buddhists',
  'buddhism', 'sikh', 'sikhs', 'mormon', 'mormons', 'atheist', 'atheists', 'scientology',
  'jehovah', 'jain', 'jains', 'pagan', 'pagans', 'wiccan', 'wiccans', 'bahai', 'baha i',
  'resort', 'resorts', 'salesman', 'salesmen', 'saleswoman', 'saleswomen',
  'salesperson', 'salespeople', 'sales rep', 'sales reps', 'timeshare', 'timeshares', 'time share',
  'black people', 'white people', 'people of color', 'blacks', 'whites', 'african', 'africans',
  'asian', 'asians', 'chinese', 'japanese', 'korean', 'koreans', 'latino', 'latinos', 'latina',
  'latinas', 'hispanic', 'hispanics', 'mexican', 'mexicans', 'indian', 'indians', 'arab', 'arabs',
  'native american', 'native americans', 'immigrant', 'immigrants', 'refugee', 'refugees',
  'gay', 'gays', 'lesbian', 'lesbians', 'trans', 'transgender', 'bisexual', 'lgbt', 'lgbtq',
  'disabled', 'autistic', 'disability', 'women', 'men', 'elderly',
];
const DEROGATORY = [
  'stupid', 'dumb', 'idiot', 'idiots', 'moron', 'morons', 'scam', 'scams', 'scammer', 'scammers',
  'ripoff', 'rip off', 'rip offs', 'crook', 'crooks', 'crooked', 'corrupt', 'corruption',
  'lie', 'lies', 'liar', 'liars', 'lying', 'dishonest', 'fraud', 'frauds', 'fraudulent', 'cheat', 'cheats',
  'cheating', 'thief', 'thieves', 'steal', 'steals', 'stealing', 'evil', 'hate', 'hated',
  'hateful', 'trash', 'garbage', 'worthless', 'loser', 'losers', 'terrible', 'awful', 'worst',
  'bad', 'ugly', 'crazy', 'nuts', 'clown', 'clowns', 'cult', 'cults', 'brainwashed', 'greedy',
  'greed', 'sleazy', 'shady', 'disgusting', 'pathetic', 'lazy', 'suck', 'sucks', 'rotten',
  'backward', 'backwards', 'inferior', 'overpriced', 'prison', 'trap', 'trapped', 'regret',
  'superior', 'useless', 'gross', 'filthy', 'vermin', 'parasite', 'parasites', 'subhuman',
  'should leave', 'go home', 'not belong', 'dont belong', 'do not belong', 'ban all',
  'deport', 'exterminate', 'eliminate', 'kill', 'killing',
  'never trust', 'do not trust', 'dont trust', 'not honest', 'not smart', 'not good', 'not welcome',
];

function normalizeText(text) {
  const lookalikes = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i' };
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
    .replace(/[аеорсхуі]/g, character => lookalikes[character])
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[0134578@$!|+]/g, character =>
      ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' })[character]);
}

function matcher(terms) {
  const patterns = [...new Set(terms.map(term => normalizeText(term).replace(/[^a-z0-9]/g, '')).filter(Boolean))]
    .map(term => [...term].map(letter => `${letter}+`).join('[^a-z0-9]*'));
  return patterns.length ? new RegExp(`(?:^|[^a-z0-9])(?:${patterns.join('|')})(?=$|[^a-z0-9])`, 'i') : null;
}

const profanity = matcher([...words, 'damn', 'dammit', 'bullshit', 'wtf', 'stfu',
  'go back where you came from', 'master race', 'white power', 'white pride', 'heil hitler', 'kill all']);
const politics = matcher(POLITICAL_TERMS);
const targets = matcher(TARGETS);
const derogatory = matcher(DEROGATORY);

function moderateCaption(text, extraTerms = []) {
  const normalized = normalizeText(text);
  const forms = [normalized, normalizeText(text.replace(/[!|+@$]/g, ' '))];
  const matches = pattern => forms.some(form => pattern?.test(form));
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}\n\r\t]/u.test(normalized)) {
    return 'Please use English text so the caption safety filter can review it.';
  }
  if (matches(profanity)) return 'Please remove inappropriate or offensive language and try again.';
  if (matches(politics) || /\b(?:sen|rep|gov)\s*\./i.test(normalized)) {
    return 'Please leave political people, offices and party references out of captions.';
  }
  if (matches(targets) && matches(derogatory)) {
    return 'Please keep captions respectful toward Florida, communities, resorts, salespeople and timeshares.';
  }
  if (extraTerms.length && matches(matcher(extraTerms))) {
    return 'This caption includes a topic the host has excluded. Please try a different joke.';
  }
  return null;
}

module.exports = { moderateCaption };
