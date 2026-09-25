#include "ADS1299.h"

ADS1299::ADS1299() :
    spi(&SPI),
    settings(ADS_SPI_SPEED, MSBFIRST, SPI_MODE1)
{
}

bool ADS1299::begin()
{
    pinMode(ADS_PIN_CS, OUTPUT);
    pinMode(ADS_PIN_START, OUTPUT);
    pinMode(ADS_PIN_RESET, OUTPUT);
    pinMode(ADS_PIN_DRDY, INPUT);

    digitalWrite(ADS_PIN_CS, HIGH);
    digitalWrite(ADS_PIN_START, LOW);
    digitalWrite(ADS_PIN_RESET, HIGH);

    spi->begin(
        ADS_PIN_SCK,
        ADS_PIN_MISO,
        ADS_PIN_MOSI,
        ADS_PIN_CS);

    delay(50);

    hardwareReset();

    disableRDATAC();
    delay(10);
    writeRegister(REG_CONFIG1, 0x96); // 250SPS, internal clock (fine, no change needed)
    writeRegister(REG_CONFIG2, 0xC0); // FIXED: was 0x00, now keeps reserved bits =1,1, test signal off
    writeRegister(REG_CONFIG3, 0xEC); // FIXED: ref buffer on, BIAS buffer on, BIASREF = INTERNAL
    
    writeRegister(REG_CH1SET, 0x60);  // gain=24, normal electrode input, SRB2 open (you already did this)
    writeRegister(REG_CH2SET, 0x60);
    writeRegister(REG_CH3SET, 0x81);
    writeRegister(REG_CH4SET, 0x81);
    writeRegister(REG_CH5SET, 0x81);
    writeRegister(REG_CH6SET, 0x81);
    writeRegister(REG_CH7SET, 0x81);
    writeRegister(REG_CH8SET, 0x81);
    
    writeRegister(REG_BIAS_SENSP, 0x00); // NEW: closes the bias feedback loop on CH1
    writeRegister(REG_BIAS_SENSN, 0x00); // N side already handled via SRB1, leave open
    
    writeRegister(REG_MISC1, 0x20);   // SRB1 routed to all negative inputs (you already had this — keep it)

    return true;
}

void ADS1299::csLow()
{
    spi->beginTransaction(settings);
    digitalWrite(ADS_PIN_CS, LOW);
}

void ADS1299::csHigh()
{
    digitalWrite(ADS_PIN_CS, HIGH);
    spi->endTransaction();
}

uint8_t ADS1299::transfer(uint8_t value)
{
    return spi->transfer(value);
}

void ADS1299::hardwareReset()
{
    digitalWrite(ADS_PIN_RESET, LOW);
    delay(5);

    digitalWrite(ADS_PIN_RESET, HIGH);
    delay(25);

    csLow();
    transfer(ADS_RESET);
    csHigh();

    delay(25);
}

void ADS1299::wakeup()
{
    csLow();
    transfer(ADS_WAKEUP);
    csHigh();

    delayMicroseconds(10);
}

void ADS1299::standby()
{
    csLow();
    transfer(ADS_STANDBY);
    csHigh();

    delayMicroseconds(10);
}

void ADS1299::start()
{
    digitalWrite(ADS_PIN_START, HIGH);

    delayMicroseconds(5);

    csLow();
    transfer(ADS_START);
    csHigh();

    delayMicroseconds(10);
}

void ADS1299::stop()
{
    csLow();
    transfer(ADS_STOP);
    csHigh();

    delayMicroseconds(10);

    digitalWrite(ADS_PIN_START, LOW);
}

void ADS1299::enableRDATAC()
{
    csLow();
    transfer(ADS_RDATAC);
    csHigh();

    delayMicroseconds(10);
}

void ADS1299::disableRDATAC()
{
    csLow();
    transfer(ADS_SDATAC);
    csHigh();

    delayMicroseconds(10);
}

bool ADS1299::waitForDRDY(uint32_t timeout_ms)
{
    uint32_t t0 = millis();

    while (digitalRead(ADS_PIN_DRDY))
    {
        if ((millis() - t0) > timeout_ms)
            return false;
    }

    while (!digitalRead(ADS_PIN_DRDY))
    {
        if ((millis() - t0) > timeout_ms)
            return false;
    }

    return true;
}

uint32_t ADS1299::countDRDYPulses(uint32_t milliseconds)
{
    uint32_t count = 0;

    uint32_t startTime = millis();

    bool previous = digitalRead(ADS_PIN_DRDY);

    while ((millis() - startTime) < milliseconds)
    {
        bool state = digitalRead(ADS_PIN_DRDY);

        if (previous && !state)
            count++;

        previous = state;
    }

    return count;
}

String byteToBinary(uint8_t value)
{
    String s;

    for (int i = 7; i >= 0; i--)
    {
        if (value & (1 << i))
            s += '1';
        else
            s += '0';
    }

    return s;
}
void ADS1299::stressCS()
{
    Serial.println("\n--- CS STABILITY TEST ---");

    for(int i = 0; i < 50; i++)
    {
        uint8_t id = readRegister(REG_ID);

        Serial.print("ID[");
        Serial.print(i);
        Serial.print("] = 0x");
        Serial.println(id, HEX);

        delay(20);
    }

    Serial.println("--- END CS TEST ---\n");
}

void printDivider(Stream &port)
{
    port.println("--------------------------------------------");
}
