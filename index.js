import express from 'express';
import { yt } from './scrape/y2mate.js';
import { play } from './scrape/play.js'; // Sesuaikan dengan path yang benar

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/youtube', async (req, res) => {
  const youtubeUrl = req.query.q;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
  }

  try {
    const result = await yt(youtubeUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/play', async (req, res) => {
  const youtubeUrl = req.query.q;

  if (!query) {
    return res.status(400).json({ error: 'Invalid or missing query' });
  }

  try {
    const result = await play(query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Kode untuk menjaga server tetap hidup setiap 1 menit
setInterval(() => {
  // Lakukan permintaan ke server Anda untuk menjaga server tetap hidup
  fetch('https://a5060d82-fa48-43cb-a719-c2d2132342a6-00-3r88tjopz26sx.kirk.replit.dev/youtube?q=')
}, 60 * 1000); // Lakukan permintaan setiap 1 menit
