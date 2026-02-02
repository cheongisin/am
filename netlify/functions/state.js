// netlify/functions/state.js
let STORE = {}; // 메모리 저장 (테스트용)

exports.handler = async (event) => {
  const { httpMethod, queryStringParameters, body } = event;

  // GET ?room=1234
  if (httpMethod === "GET") {
    const room = queryStringParameters.room;
    if (!room || !STORE[room]) {
      return {
        statusCode: 404,
        body: JSON.stringify({ ok: false, error: "not_found" })
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, state: STORE[room] })
    };
  }

  // POST (save state)
  if (httpMethod === "POST") {
    const data = JSON.parse(body || "{}");
    if (!data.roomCode) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "missing_roomCode" })
      };
    }
    STORE[data.roomCode] = data;
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  }

  return {
    statusCode: 405,
    body: "Method Not Allowed"
  };
};
