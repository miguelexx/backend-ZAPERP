const jwt = require("jsonwebtoken");

module.exports = (socket, next) => {
  try {
    const token = socket.handshake?.auth?.token;
    if (!token) return next(new Error("Socket sem token"));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.company_id) return next(new Error("Token sem company_id"));

    socket.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      company_id: decoded.company_id,
    };

    next();
  } catch (err) {
    console.error("❌ Socket auth error:", err.message);
    next(new Error("Token inválido no socket"));
  }
};
