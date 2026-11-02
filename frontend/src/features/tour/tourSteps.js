import { careImages } from '../../assets/care/index.js';

/**
 * The patient tour, in plain words: one idea on each step. `target` names the
 * data-tour="…" element to light up on the home page; a step without one, or whose element
 * isn't on screen, simply shows its card.
 */
export const TOUR_STEPS = [
  {
    title: 'Welcome to HealthBridge',
    text: 'This short tour shows you where everything is. It takes about one minute.',
    image: careImages.welcome,
  },
  {
    target: 'next',
    title: 'What to do next',
    text: 'Your next appointment, or your next step, is always at the top of this page.',
    image: careImages.visit,
  },
  {
    target: 'doctors',
    title: 'Find your doctor',
    text: 'Look for the doctor you trust and ask to join their care. Then you can book with them.',
    image: careImages.doctors,
  },
  {
    target: 'assistant',
    title: 'Ask for help in your own words',
    text: 'Type what you need, like “a skin doctor tomorrow morning”. The assistant finds doctors and free times.',
    image: careImages.assistant,
  },
  {
    target: 'appointments',
    title: 'See your appointments',
    text: 'All your visits are here. For an online visit, you join the video call from here.',
    image: careImages.online,
  },
  {
    target: 'reports',
    title: 'Keep your reports safe',
    text: 'Add your reports here. Doctors see them only if you allow it.',
    image: careImages.reports,
  },
  {
    target: 'medicines',
    title: 'Check your medicines',
    text: 'Prescriptions from your doctors are here, with how to take each medicine.',
    image: careImages.medicines,
  },
  {
    target: 'checkin',
    title: 'Tell your doctor how you feel',
    text: 'After a visit, your doctor may ask how you are. Your answers go straight to them.',
    image: careImages.checkin,
  },
  {
    target: 'text-size',
    title: 'Make the words bigger',
    text: 'Press this button to make the words larger. Press it again to change them back.',
  },
  {
    target: 'emergency',
    title: 'In an emergency',
    text: 'Call 112 or 108, or go to the nearest emergency department. Don’t wait for an online visit.',
  },
];
