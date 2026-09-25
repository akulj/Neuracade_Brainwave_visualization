#include "ADS1299.h"

static unsigned long windowStart = 0;
static long blinkSamples = 0;

static long sampleCount = 0;

static double sum = 0;
static double sumSq = 0;

static long positiveCount = 0;
static long negativeCount = 0;

/***********************************************************************
    Sign extend a 24-bit value to int32_t
************************************************************************/

int32_t ADS1299::signExtend24(uint32_t value)
{
    value &= 0xFFFFFF;

    if(value & 0x800000)
        value |= 0xFF000000;

    return (int32_t)value;
}

/***********************************************************************
    Read one complete ADS1299 conversion packet

    Packet:
        3 Status Bytes
        8 Channels × 3 Bytes
************************************************************************/

bool ADS1299::readDataPacket(ADS1299Packet &packet)
{
    if(!waitForDRDY(100))
        return false;

    csLow();

    transfer(ADS_RDATA);

    delayMicroseconds(5);

    for(int i=0;i<3;i++)
        packet.status[i]=transfer(0x00);

    for(int ch=0;ch<8;ch++)
    {
        uint32_t raw=0;

        raw |= ((uint32_t)transfer(0x00))<<16;
        raw |= ((uint32_t)transfer(0x00))<<8;
        raw |= ((uint32_t)transfer(0x00));

        packet.channel[ch]=signExtend24(raw);
    }

    csHigh();

    return true;
}

/***********************************************************************
    Print decoded packet
************************************************************************/

void ADS1299::printPacket(
    Stream &port,
    const ADS1299Packet &packet)
{
    port.println();
    printDivider(port);
    port.println("ADS1299 DATA PACKET");
    printDivider(port);

    port.print("STATUS = ");

    for(int i=0;i<3;i++)
    {
        if(packet.status[i]<16)
            port.print("0");

        port.print(packet.status[i],HEX);
        port.print(" ");
    }

    port.println();

    for(int i=0;i<8;i++)
    {
        port.print("CH");
        port.print(i+1);

        if(i<9)
            port.print(" ");

        port.print(" = ");

        port.println(packet.channel[i]);
    }

    printDivider(port);
}

/***********************************************************************
    Stream channels for Arduino Serial Plotter

    Output:
    ch1 ch2 ch3 ... ch8
    ch1 ch2 ch3 ... ch8
************************************************************************/
void ADS1299::streamPlotter()
{
    ADS1299Packet packet;

    if(!readDataPacket(packet))
        return;

    const float scale = (4.5f * 1000000.0f) / (24.0f * 8388607.0f);
    float microvolts = (float)packet.channel[0] * scale;

    // Print raw microvolts instead of filtered
   for(int i = 0; i < 8; i++) {
        float microvolts = (float)packet.channel[i] * scale;
        Serial.print(microvolts);
        
        // Print a space between channels, but not after the last channel
        if(i < 7) {
            Serial.print(" ");
        }
    }
      Serial.println(); 

        Serial.print(microvolts);
        Serial.print(" ");
        Serial.println(); 
}
/***********************************************************************
    Check whether packets are changing
************************************************************************/

bool ADS1299::verifyDataChanging(Stream &port)
{
    ADS1299Packet a;
    ADS1299Packet b;

    if(!readDataPacket(a))
    {
        port.println("FAILED TO READ PACKET A");
        return false;
    }

    delay(20);

    if(!readDataPacket(b))
    {
        port.println("FAILED TO READ PACKET B");
        return false;
    }

    bool changed=false;

    for(int i=0;i<8;i++)
    {
        if(a.channel[i]!=b.channel[i])
            changed=true;
    }

    if(changed)
        port.println("DATA IS CHANGING");
    else
        port.println("WARNING: DATA IDENTICAL");

    return changed;
}

/***********************************************************************
    Estimate output data rate by counting DRDY pulses
************************************************************************/

void ADS1299::measureDRDY(Stream &port)
{
    port.println();
    port.println("Monitoring DRDY for 1000 ms...");

    uint32_t pulses=countDRDYPulses(1000);

    port.print("DRDY Falling Edges = ");
    port.println(pulses);

    if(pulses==0)
    {
        port.println();
        port.println("*** DRDY NEVER TOGGLED ***");
        port.println();
        port.println("Possible causes:");
        port.println("  START pin LOW");
        port.println("  RESET asserted");
        port.println("  Clock missing");
        port.println("  ADS1299 still in standby");
        port.println("  Incorrect jumper configuration");
        return;
    }

    port.print("Estimated SPS = ");
    port.println(pulses);

    if(pulses<100)
        port.println("WARNING: Unexpectedly low data rate.");

    if(pulses>17000)
        port.println("WARNING: Unexpectedly high data rate.");
}

/***********************************************************************
    Quick self-test for conversions
************************************************************************/

bool ADS1299::conversionSelfTest(Stream &port)
{
    port.println();
    printDivider(port);
    port.println("CONVERSION SELF TEST");
    printDivider(port);
    enableRDATAC();
    delay(10);
    start();

    delay(10);

    measureDRDY(port);

    ADS1299Packet packet;

    if(!readDataPacket(packet))
    {
        port.println();
        port.println("NO DATA PACKET RECEIVED");
        return false;
    }

    printPacket(port,packet);

    verifyDataChanging(port);

    return true;
}
