// ==================================================================
// Hand ESP32 firmware — WiFi/WebSocket version
//
// WHY THIS EXISTS: the original sketch took commands over the same
// USB serial link used for high-rate EEG streaming, which is exactly
// the kind of shared channel that causes clashes/corruption. This
// version takes commands over WiFi (WebSocket) instead, completely
// independent of any serial connection. Serial is kept ONLY for local
// debugging over USB at the bench — it is no longer the command path.
//
// LIBRARY NEEDED (Arduino Library Manager):
//   "WebSockets" by Markus Sattler (Links2004/arduinoWebSockets)
//
// SETUP STEPS:
//   1. Fill in WIFI_SSID / WIFI_PASSWORD below.
//   2. Flash this, open Serial Monitor at 115200 — it prints this
//      board's MAC address and IP address on boot.
//   3. In your router's admin page, add a DHCP RESERVATION binding
//      that MAC address to a fixed IP (this is the practical
//      equivalent of "addressing by MAC" from a browser, which can
//      only speak IP/WebSocket, not raw MAC-level protocols).
//   4. Put that fixed IP into the dashboard's "Hand ESP32 address"
//      field on the Gesture Control tab.
//
// HARDWARE NOTE (brownout): power the four servos from their own 5V
// supply (2-3A capable) with a bulk capacitor (1000-2200uF electrolytic
// + 0.1uF ceramic) right at the servo power leads, grounded in common
// with the ESP32. Don't power servos from the ESP32's own 5V/3.3V pin.
// ==================================================================

#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ESP32Servo.h>

// --- WIFI CONFIG ---
const char* WIFI_SSID     = "Ethan's iPhone";
const char* WIFI_PASSWORD = "107103Eh";

// Optional: force a static IP instead of relying on a DHCP reservation.
// Leave USE_STATIC_IP false if you're doing the router-reservation approach.
const bool USE_STATIC_IP = false;
IPAddress STATIC_IP(172, 20, 10, 2);
IPAddress GATEWAY(172, 20, 10, 1);
IPAddress SUBNET(255, 255, 255, 240);

WebSocketsServer webSocket = WebSocketsServer(81);

// --- SERVO OBJECTS ---
Servo thumbServo;
Servo indexServo;
Servo middleServo;
Servo pinkyRingServo;

// --- CONFIGURATION: ESP32 PINS ---
const int PIN_THUMB  = 13;
const int PIN_INDEX  = 12;
const int PIN_MIDDLE = 14;
const int PIN_PINKY  = 27;

// --- CONFIGURATION: DIGITAL TARGET POSITIONS (0 to 180) ---
const int THUMB_HOME  = 10;   const int THUMB_CLOSED  = 150;
const int INDEX_HOME  = 160;   const int INDEX_CLOSED  = 20;
const int MIDDLE_HOME = 160;    const int MIDDLE_CLOSED = 20;
const int PINKY_HOME  = 20;   const int PINKY_CLOSED  = 140;

void moveServoSmooth(Servo &servo, int target, int stepDelayMs = 8);


void setup() {
  Serial.begin(115200);
  delay(200);

  // Allow allocation of all ESP32 PWM timers
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  thumbServo.setPeriodHertz(50);
  indexServo.setPeriodHertz(50);
  middleServo.setPeriodHertz(50);
  pinkyRingServo.setPeriodHertz(50);

  thumbServo.attach(PIN_THUMB, 500, 2400);
  indexServo.attach(PIN_INDEX, 500, 2400);
  middleServo.attach(PIN_MIDDLE, 500, 2400);
  pinkyRingServo.attach(PIN_PINKY, 500, 2400);

  openAll();

  // --- WiFi ---
  if (USE_STATIC_IP) {
    WiFi.config(STATIC_IP, GATEWAY, SUBNET);
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("MAC address: ");
  Serial.println(WiFi.macAddress()); // <-- use this to set up the DHCP reservation

  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected. IP address: ");
  Serial.println(WiFi.localIP());

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);

  Serial.println("System Ready. Commands now arrive over WebSocket (port 81), not Serial.");
}

void loop() {
  webSocket.loop();

  // Serial command path is kept ONLY for bench testing without WiFi —
  // it is not used by the dashboard anymore.
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    processCommand(command);
  }
}

// ==================================================================
// WebSocket event handler
// ==================================================================
void webSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("Client #%u connected\n", num);
      webSocket.sendTXT(num, "hand_ready");
      break;
    case WStype_DISCONNECTED:
      Serial.printf("Client #%u disconnected\n", num);
      break;
    case WStype_TEXT: {
      String command;
      command.reserve(length);
      for (size_t i = 0; i < length; i++) command += (char)payload[i];
      command.trim();
      processCommand(command);
      break;
    }
    default:
      break;
  }
}

// ==================================================================
// Command dispatch — shared by WebSocket and the bench-test Serial path.
// Vocabulary matches what the dashboard's gesture detector sends.
// ==================================================================
void processCommand(const String& command) {
  if (command == "close_fist" || command == "Hand_close") {
    closeAll();
  } else if (command == "open_hand" || command == "Hand_open") {
    openAll();
  } else if (command == "close_index_finger") {
    Serial.println("Command: pointing gesture (index closed, rest home)");
    moveServoSmooth(indexServo, INDEX_CLOSED);
    moveServoSmooth(thumbServo, THUMB_HOME);
    moveServoSmooth(middleServo, MIDDLE_HOME);
    moveServoSmooth(pinkyRingServo, PINKY_HOME);
  } else if (command == "index_close") {
    moveServoSmooth(indexServo, INDEX_CLOSED);
  } else if (command == "index_open") {
    moveServoSmooth(indexServo, INDEX_HOME);
  } else if (command.length() > 0) {
    Serial.print("Unknown command received: ");
    Serial.println(command);
  }
}

// ==================================================================
// Helper: move one servo in small steps instead of one big jump.
// Cuts peak current draw compared to Servo.write() jumping straight
// to the target — helps avoid brownout resets when several servos
// move close together in time. Not a substitute for the power-supply
// fixes above, just a complement to them.
// ==================================================================
void moveServoSmooth(Servo &servo, int target, int stepDelayMs) {
    int current = servo.read();
    int step = (target > current) ? 1 : -1;
    while (current != target) {
        current += step;
        servo.write(current);
        delay(stepDelayMs);
    }
}


// --- HELPER FUNCTIONS FOR BULK MOVEMENT ---
// Staggered: each servo starts its ramp ~40ms after the previous one,
// spreading out the current draw instead of all four servos surging
// at the same instant.
void openAll() {
  Serial.println("Command: Hand_open (all fingers home)");
  moveServoSmooth(thumbServo, THUMB_HOME);
  delay(40);
  moveServoSmooth(indexServo, INDEX_HOME);
  delay(40);
  moveServoSmooth(middleServo, MIDDLE_HOME);
  delay(40);
  moveServoSmooth(pinkyRingServo, PINKY_HOME);
}

void closeAll() {
  Serial.println("Command: Hand_close (fist)");
  moveServoSmooth(thumbServo, THUMB_CLOSED);
  delay(40);
  moveServoSmooth(indexServo, INDEX_CLOSED);
  delay(40);
  moveServoSmooth(middleServo, MIDDLE_CLOSED);
  delay(40);
  moveServoSmooth(pinkyRingServo, PINKY_CLOSED);
}
