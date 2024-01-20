import fetch from 'node-fetch';
import axios from 'axios';

// Constants Url Scraping
const Y2MATE_API_URL = 'https://www.y2mate.com/mates/';
const Y2MATE_CONVERT_URL = 'https://www.y2mate.com/mates/convertV2/index';

// Function to analyze a YouTube thumbnail using Y2Mate
async function analyze(url, server = 'en68') {
  const ytIdRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/;
  let ytIdMatch = ytIdRegex.exec(url);

  if (!ytIdMatch) {
    throw new Error('Invalid YouTube video URL');
  }

  let ytId = ytIdMatch[1];
  url = `https://youtu.be/${ytId}`;

  try {
    console.log('YouTube Video ID:', ytId);

    const response = await fetch(`${Y2MATE_API_URL}${server}/analyze/ajax`, {
      method: 'POST',
      headers: {
        accept: "*/*",
        'accept-language': "en-US,en;q=0.9",
        'content-type': "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: new URLSearchParams({
        url,
        q_auto: 0,
        ajax: 1
      }),
    });

    if (!response.ok) {
      throw new Error(`Y2Mate API (analyze) Error: ${response.statusText}`);
    }

    const responseBody = await response.text();

    if (!responseBody.trim()) {
      throw new Error(`Empty response body from Y2Mate API (analyze)`);
    }

    const json = JSON.parse(responseBody);

    if (!json || (json.result && Object.keys(json.result).length === 0)) {
      throw new Error(`Invalid or empty JSON response from Y2Mate API (analyze)`);
    }

    const thumbnailSrc = json.result && json.result.indexOf('<img src="https://i.ytimg.com/') !== -1 ? json.result.match(/<img src="([^"]+)"/)[1] : null;

    return {
      thumbnail: thumbnailSrc,
      analyzeResult: json,
    };
  } catch (error) {
    console.error('Error during Y2Mate API (analyze) request:', error);
    throw new Error('Terjadi kesalahan: ' + error.message);
  }
}

// Function to analyze a YouTube video key using Y2Mate V2
async function analyzeV2(url, server = 'id') {
  try {
    const response = await axios.post(`${Y2MATE_API_URL}${server}/analyzeV2/ajax`, new URLSearchParams({
      k_query: url,
      k_page: 'home',
      hl: 'id',
      q_auto: 0,
      ajax: 1,
    }), {
      headers: {
          "Accept": "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7,es;q=0.6,zh-CN;q=0.5,zh;q=0.4",
          "Content-Length": "90",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Cookie": "_ga=GA1.1.335270984.1705371720;_pbjs_userid_consent_data=3524755945110770;prefetchAd_3381349=true; _ga_PSRPB96YVC-GS1.1.1705575542.4.1.1705575561.0.0.0",
          "Origin": "https://www.y2mate.com",
          "Referer": "https://www.y2mate.com/id/youtube/youtubeid",
          "Sec-Ch-Ua": "\"Not)A;Brand\",v=\"24\", \"Chromium\";y=\"116\"",
          "Sec-Ch-Ua-Mobile": "?1",
          "Sec-Ch-Ua-Platform": "\"Android\"",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
          "X-Requested-With": "XMLHttpRequest"
      },
    });

    console.log('Y2Mate API (analyzeV2) Response:', response.status);

    const key360p = response.data.links?.mp4?.['18']?.k;
    const keyM4A = response.data.links?.mp3?.['140']?.k;
    const title = response.data.title;
    const ytIdLink = response.data.vid;
    const videoUrl = `https://www.youtube.com/watch?v=${ytIdLink}`;

    if (!key360p) {
      throw new Error('Key for MP4 360p not found in Y2Mate API (analyzeV2) response');
    }

    if (!keyM4A) {
      throw new Error('Key for MP3 M4A not found in Y2Mate API (analyzeV2) response');
    }

    return {
      analyzeResult: response.data,
      key360p,
      keyM4A,
      title,
      ytIdLink,
      videoUrl,
    };
  } catch (error) {
    console.error('Error during Y2Mate API (analyzeV2) request:', error);
    throw new Error('Terjadi kesalahan: ' + error.message);
  }
}

// Function to convert Key to Video Url using Y2Mate V2
async function convertV2(url, key, server = 'id') {
  try {
    // Extract video ID from the provided YouTube URL
    const ytIdRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/;
    const ytIdMatch = ytIdRegex.exec(url);

    if (!ytIdMatch) {
      throw new Error('Invalid YouTube video URL');
    }

    const ytId = ytIdMatch[1];

    const response = await axios.post(
      `${Y2MATE_API_URL}convertV2/index`,
      new URLSearchParams({
        vid: ytId,
        k: key,
      }),
      {
        headers: {
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7,es;q=0.6,zh-CN;q=0.5,zh;q=0.4',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Cookie': '_ga=GA1.1.335270984.1705371720;_pbjs_userid_consent_data=3524755945110770;_ga_PSRPB96YVC-GS1.1.1705575542.4.1.1705575741.0.0.0',
          'Origin': 'https://www.y2mate.com',
          'Referer': 'https://www.y2mate.com/id/youtube/id youtube',
          'Sec-Ch-Ua': '"Not)A;Brand";v="24", "Chromium",v="116"',
          'Sec-Ch-Ua-Mobile': '?1',
          'Sec-Ch-Ua-Platform': '"Android"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest',
        },
      }
    );

    const dlink = response.data.dlink;

    // Handle response as needed

    return response.data;
      // Adjust this based on the actual response structure
  } catch (error) {
    console.error('Error during Y2Mate API (convertV2) request:', error);
    throw new Error('Terjadi kesalahan: ' + error.message);
  }
}

// Main function for YouTube video processing
async function yt(url, server = 'id') {
  try {
    const analyzeResult = await analyze(url, server);
    const analyzeV2Result = await analyzeV2(url, server);
    const convertV2Mp4Result = await convertV2(url, analyzeV2Result.key360p, server);
    const convertV2Mp3Result = await convertV2(url, analyzeV2Result.keyM4A, server);


    return {
      status: true,
      creator: 'KeiLaSenpai',
      title: analyzeV2Result.title,
      thumbnail: analyzeResult.thumbnail,
      videoUrl: analyzeV2Result.videoUrl,
      result: {
        video: convertV2Mp4Result.dlink,
        audio: convertV2Mp3Result.dlink,
      },
    };
  } catch (error) {
    console.error('Error during Y2Mate API request:', error.message);
    throw new Error('Terjadi kesalahan: ' + error.message);
  }
}

export { yt };
