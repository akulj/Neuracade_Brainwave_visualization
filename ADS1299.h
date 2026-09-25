#ifndef ADS1299_H
#define ADS1299_H

#include <Arduino.h>
#include <SPI.h>

/***********************************************************************
    ADS1299 Commands
************************************************************************/
#define ADS_WAKEUP     0x02
#define ADS_STANDBY    0x04
#define ADS_RESET      0x06
#define ADS_START      0x08
#define ADS_STOP       0x0A
#define ADS_RDATAC     0x10
#define ADS_SDATAC     0x11
#define ADS_RDATA      0x12

#define ADS_RREG       0x20
#define ADS_WREG       0x40

/***********************************************************************
    Register Map
************************************************************************/

enum ADS1299_Register
{
    REG_ID           = 0x00,
    REG_CONFIG1      = 0x01,
    REG_CONFIG2      = 0x02,
    REG_CONFIG3      = 0x03,
    REG_LOFF         = 0x04,

    REG_CH1SET       = 0x05,
    REG_CH2SET       = 0x06,
    REG_CH3SET       = 0x07,
    REG_CH4SET       = 0x08,
    REG_CH5SET       = 0x09,
    REG_CH6SET       = 0x0A,
    REG_CH7SET       = 0x0B,
    REG_CH8SET       = 0x0C,

    REG_BIAS_SENSP   = 0x0D,
    REG_BIAS_SENSN   = 0x0E,

    REG_LOFF_SENSP   = 0x0F,
    REG_LOFF_SENSN   = 0x10,

    REG_LOFF_FLIP    = 0x11,

    REG_LOFF_STATP   = 0x12,
    REG_LOFF_STATN   = 0x13,

    REG_GPIO         = 0x14,
    REG_MISC1        = 0x15,
    REG_MISC2        = 0x16,
    REG_CONFIG4      = 0x17
};

/***********************************************************************
    Register Names
************************************************************************/

static const char* const ADS_RegisterNames[24] =
{
    "ID",
    "CONFIG1",
    "CONFIG2",
    "CONFIG3",
    "LOFF",

    "CH1SET",
    "CH2SET",
    "CH3SET",
    "CH4SET",
    "CH5SET",
    "CH6SET",
    "CH7SET",
    "CH8SET",

    "BIAS_SENSP",
    "BIAS_SENSN",

    "LOFF_SENSP",
    "LOFF_SENSN",

    "LOFF_FLIP",

    "LOFF_STATP",
    "LOFF_STATN",

    "GPIO",
    "MISC1",
    "MISC2",
    "CONFIG4"
};

/***********************************************************************
    ESP32 Pin Definitions

    CHANGE THESE HERE ONLY
************************************************************************/

#define ADS_PIN_CS         2
#define ADS_PIN_DRDY       4
#define ADS_PIN_RESET     22
#define ADS_PIN_START      5

#define ADS_PIN_SCK       18
#define ADS_PIN_MISO      19
#define ADS_PIN_MOSI      23

/***********************************************************************
    SPI
************************************************************************/

#define ADS_SPI_SPEED   1000000

/***********************************************************************
    Conversion Packet
************************************************************************/

struct ADS1299Packet
{
    uint8_t status[3];

    int32_t channel[8];
};

/***********************************************************************
    Driver Class
************************************************************************/

class ADS1299
{

public:

    ADS1299();
    void streamPlotter();

    bool begin();
    void stressCS();

    void hardwareReset();

    void wakeup();

    void standby();

    void start();

    void stop();

    void enableRDATAC();

    void disableRDATAC();

    uint8_t readRegister(uint8_t reg);

    void readRegisters(
            uint8_t start,
            uint8_t count,
            uint8_t *buffer);

    void writeRegister(
            uint8_t reg,
            uint8_t value);

    void dumpRegisters(Stream &port);

    bool verifyRegisters(Stream &port);

    bool verifyReadWrite(Stream &port);

    uint8_t readID();

    bool waitForDRDY(uint32_t timeout_ms);

    bool readDataPacket(ADS1299Packet &packet);

    void printPacket(
            Stream &port,
            const ADS1299Packet &packet);

    uint32_t countDRDYPulses(uint32_t milliseconds);
    bool verifyDataChanging(Stream &port);

    void measureDRDY(Stream &port);

    bool conversionSelfTest(Stream &port);

private:

    SPIClass *spi;

    SPISettings settings;

    void csLow();

    void csHigh();

    uint8_t transfer(uint8_t value);

    int32_t signExtend24(uint32_t value);

};

/***********************************************************************
    Utility Functions
************************************************************************/

String byteToBinary(uint8_t v);

void printDivider(Stream &port);

#endif
