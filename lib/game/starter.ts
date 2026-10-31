import type { Board } from './schema';
const categories = [
  'Around the World',
  'Science Lab',
  'Screen Time',
  'Back in Time',
  'Word Play',
  'Wild Card',
];
const trivia = [
  [
    ['What is the capital of Japan?', 'Tokyo'],
    ['Which country is home to the ancient city of Petra?', 'Jordan'],
    ['Which river flows through Paris?', 'The Seine'],
    ['Which African country was formerly called Abyssinia?', 'Ethiopia'],
    ['What is the smallest country by land area?', 'Vatican City'],
  ],
  [
    ['What planet is known as the Red Planet?', 'Mars'],
    ['What is the chemical symbol for gold?', 'Au'],
    ['What force keeps planets in orbit around the Sun?', 'Gravity'],
    ['What organelle is often called the powerhouse of the cell?', 'The mitochondrion'],
    ['What is the SI unit of electrical resistance?', 'The ohm'],
  ],
  [
    ['What fictional school does Harry Potter attend?', 'Hogwarts'],
    ['Who directed Jurassic Park (1993)?', 'Steven Spielberg'],
    ['In The Matrix, which pill does Neo take?', 'The red pill'],
    ['What is the name of the fictional African nation in Black Panther?', 'Wakanda'],
    [
      'Which 1927 film is widely known as the first feature-length movie with synchronized spoken dialogue?',
      'The Jazz Singer',
    ],
  ],
  [
    ['Who was the first president of the United States?', 'George Washington'],
    ['In which year did humans first land on the Moon?', '1969'],
    ['Which civilization built Machu Picchu?', 'The Inca'],
    ['What document was sealed by King John in 1215?', 'Magna Carta'],
    ['Which treaty ended the Thirty Years’ War in 1648?', 'The Peace of Westphalia'],
  ],
  [
    ['What is a word with the opposite meaning of another called?', 'An antonym'],
    ['What five-letter word becomes shorter when you add two letters?', 'Short'],
    ['What is a word or phrase that reads the same backward called?', 'A palindrome'],
    ['What term describes words that sound alike but have different meanings?', 'Homophones'],
    [
      'What word contains all five vowels in alphabetical order and means treating serious issues with inappropriate humor?',
      'Facetious',
    ],
  ],
  [
    ['How many sides does a hexagon have?', 'Six'],
    ['What instrument has keys, pedals, and strings?', 'A piano'],
    ['Which chess piece moves in an L shape?', 'The knight'],
    ['What is the main ingredient in traditional hummus?', 'Chickpeas'],
    ['What is the name of the scale used to measure mineral hardness?', 'The Mohs scale'],
  ],
];
export function blankBoard(): Board {
  return {
    title: 'Untitled game night',
    categories: [...categories],
    rows: 5,
    questions: categories.flatMap((_, category) =>
      Array.from({ length: 5 }, (_, row) => ({
        id: crypto.randomUUID(),
        category,
        row,
        value: (row + 1) * 200,
        prompt: '',
        answer: '',
        notes: '',
        dailyDouble: category === 2 && row === 3,
      })),
    ),
    final: { category: '', prompt: '', answer: '' },
  };
}
export function starterBoard(): Board {
  const board = blankBoard();
  board.title = 'The Game Night Starter';
  for (const q of board.questions) {
    [q.prompt, q.answer] = trivia[q.category][q.row];
  }
  board.final = {
    category: 'World Landmarks',
    prompt:
      'This Indian mausoleum on the banks of the Yamuna was commissioned by Shah Jahan in memory of Mumtaz Mahal. Name it.',
    answer: 'The Taj Mahal',
  };
  return board;
}
