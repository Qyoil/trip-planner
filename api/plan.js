// Vercel Serverless Function: /api/plan.js
// 프론트엔드에서 받은 조건으로 Gemini API를 호출하여 실제 존재하는 장소 기반 일정을 JSON으로 반환합니다.

export default async function handler(req, res) {
    // POST 요청만 허용
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.' });
    }

    try {
        const { destination, duration, companion, interests } = req.body;

        if (!destination) {
            return res.status(400).json({ error: '여행지(destination)를 입력해야 합니다.' });
        }

        // Gemini에게 두루뭉술한 표현을 금지하고 실존 상호명/장소명/꿀팁을 강제하는 프롬프트
        const prompt = `
당신은 현지 지리에 매우 밝은 베테랑 여행 플래너입니다.
아래 조건에 맞춰 실제 존재하는 유명한 식당, 카페, 관광지, 쇼핑 명소만을 사용해 구체적인 여행 일정을 작성해 주세요.

[여행 조건]
- 여행지: ${destination}
- 기간: ${duration || '2박 3일'}
- 동행자: ${companion || '친구와'}
- 주요 관심사: ${interests || '맛집탐방, 대표 명소'}

[필수 규칙]
1. 절대 "유명 맛집 탐방", "인기 브런치 카페", "랜드마크 전망대", "로컬 이자카야"처럼 추상적이거나 두루뭉술하게 적지 마세요.
2. 반드시 실제 존재하는 정확한 가게 상호명, 관광지 공식 명칭, 동네 이름을 구체적으로 명시하세요. (예: "이치란 라멘 시부야점", "성산일출봉", "런던베이글뮤지엄 안국점")
3. 동선이 겹치거나 무리하지 않도록 지리적으로 인접한 구역끼리 하루 일정을 묶어주세요.
4. 각 일정마다 방문 꿀팁(예약 필요 여부, 대표 메뉴, 추천 시간대 등)을 1문장으로 포함하세요.
5. 각 장소의 사진을 검색하기 위한 '영어 명칭 또는 핵심 키워드(imageQuery)'를 반드시 함께 제공하세요. (예: "Senso-ji", "Shibuya Sky", "Tsukemen ramen")
6. 반드시 아래 JSON 형식으로만 응답하세요. 마크다운 코드블록(\`\`\`json)이나 다른 설명 텍스트는 절대 포함하지 마세요.

{
  "title": "매력적인 여행 일정 제목",
  "subtitle": "동행자와 관심사를 반영한 한 줄 요약",
  "days": [
    {
      "day": 1,
      "title": "1일차 핵심 구역 및 테마",
      "schedule": [
        {
          "time": "10:00",
          "title": "구체적인 활동 요약",
          "placeName": "실제 존재하는 정확한 장소/상호명",
          "imageQuery": "Wikipedia or photo search keyword in English",
          "desc": "이곳에서 무엇을 보고 먹는지 구체적인 설명 (2문장 이내)",
          "tip": "실용적인 방문 팁 (예약, 대표메뉴, 이동 팁 등)"
        }
      ]
    }
  ]
}
`;

        // Gemini 2.5 Flash 모델 호출 (Structured JSON 응답 모드 활성화)
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [{ text: prompt }]
                    }
                ],
                generationConfig: {
                    temperature: 0.7,
                    responseMimeType: "application/json"
                }
            })
        });

        if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            console.error('Gemini API Error:', errText);
            return res.status(geminiResponse.status).json({ error: 'Gemini API 호출에 실패했습니다.', details: errText });
        }

        const geminiData = await geminiResponse.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) {
            return res.status(500).json({ error: 'Gemini로부터 유효한 응답을 받지 못했습니다.' });
        }

        // 혹시 포함될 수 있는 마크다운 백틱 제거 후 JSON 파싱
        const cleanedJsonText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const itineraryJson = JSON.parse(cleanedJsonText);

        // 각 일정 항목마다 위키피디아 API에서 실제 지명 사진 1장씩 병렬 조회
        if (itineraryJson.days && Array.isArray(itineraryJson.days)) {
            await Promise.all(
                itineraryJson.days.map(async (day) => {
                    if (!Array.isArray(day.schedule)) return;
                    await Promise.all(
                        day.schedule.map(async (item) => {
                            const query = item.imageQuery || item.placeName;
                            item.imageUrl = await fetchPlaceImage(query);
                        })
                    );
                })
            );
        }

        return res.status(200).json(itineraryJson);

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: '일정 생성 중 서버 오류가 발생했습니다.', message: error.message });
    }
}

// 위키피디아(영문/한국어) 무료 API를 통해 실제 장소 썸네일 이미지를 가져오는 헬퍼 함수
async function fetchPlaceImage(query) {
    if (!query) return null;
    try {
        // 1. 영문 위키피디아 검색 및 대표 이미지 조회
        const enUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=pageimages&pithumbsize=600&format=json&origin=*`;
        const enRes = await fetch(enUrl);
        if (enRes.ok) {
            const enData = await enRes.json();
            const pages = enData?.query?.pages;
            if (pages) {
                const firstPage = Object.values(pages)[0];
                if (firstPage?.thumbnail?.source) {
                    return firstPage.thumbnail.source;
                }
            }
        }
    } catch (e) {
        console.warn('Image fetch failed for:', query);
    }
    return null;
}
