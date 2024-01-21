import yts from 'yt-search';
import axios from 'axios';

const Y2MATE_API_URL = 'https://www.y2mate.com/mates/';
const Y2MATE_CONVERT_URL = 'https://www.y2mate.com/mates/convertV2/index';

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

    
    const key360p = response.data.links?.mp4?.['18']?.k;
    const keyM4A = response.data.links?.mp3?.['140']?.k;
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
      ytIdLink,
      videoUrl,
    };
  } catch (error) {
    console.error('Error during Y2Mate API (analyzeV2) request:', error);
    throw new Error('Terjadi kesalahan: ' + error.message);
  }
}

async function convertV2(url, key ) {
  try {
    const ytIdRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/;
    const ytIdMatch = ytIdRegex.exec(url);

    console.log('YouTube Video URL:', url);
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

    return response.data;
      
  } catch (error) {
    console.error('Error during Y2Mate API (convertV2) request:', error);
    throw new Error('Terjadi kesalahan: ' + error.message);
  }
}


async function play(query, server = 'id') {
  try {
    if (!query) throw '✳️ Apa yang Anda ingin saya telusuri di YouTube?';

    let list = await yts(query);
    let finalList = list.all;
    let firstResult = finalList[0];

    let url = firstResult.url;
    let title = firstResult.title;
    let description = firstResult.description;
    let thumbnail = firstResult.thumbnail;
    let timestamp = firstResult.timestamp;
    let ago = firstResult.ago;
    let views = firstResult.views;
    let authorName = firstResult.author.name;
    let authorUrl = firstResult.author.url;

    const analyzeV2Result = await analyzeV2(url, server);
    const convertV2Mp4Result = await convertV2(url, analyzeV2Result.key360p);
    const convertV2Mp3Result = await convertV2(url, analyzeV2Result.keyM4A);

    return {
      status: true,
      pembuat: 'KeiLaSenpai',
      judul: title,
      videoUrl: url,
      penonton: views,
      waktu: timestamp,
      tanggal: ago,
      channel: authorName,
      channelUrl: authorUrl,
      dekripsi: description,
      hasil: {
        cover: thumbnail,
        video: convertV2Mp4Result.dlink,
        music: convertV2Mp3Result.dlink,
      },
    };
  } catch (error) {
    console.error('Error during processing:', error);
    return { status: false, error: 'Terjadi kesalahan: ' + error.message };
  }
}

export { play };
