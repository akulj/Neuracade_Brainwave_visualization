#include "ADS1299.h"

uint8_t ADS1299::readRegister(uint8_t reg)
{
    uint8_t value;

    disableRDATAC();

    delayMicroseconds(5);

    csLow();

    transfer(ADS_RREG | reg);
    transfer(0x00);

    delayMicroseconds(5);

    value = transfer(0x00);

    csHigh();

    return value;
}

void ADS1299::readRegisters(
    uint8_t start,
    uint8_t count,
    uint8_t *buffer)
{
    disableRDATAC();

    delayMicroseconds(5);

    csLow();

    transfer(ADS_RREG | start);

    transfer(count - 1);

    delayMicroseconds(5);

    for (uint8_t i = 0; i < count; i++)
        buffer[i] = transfer(0x00);

    csHigh();
}

void ADS1299::writeRegister(
    uint8_t reg,
    uint8_t value)
{
    disableRDATAC();

    delayMicroseconds(5);

    csLow();

    transfer(ADS_WREG | reg);

    transfer(0x00);

    transfer(value);

    csHigh();

    delayMicroseconds(5);
}

uint8_t ADS1299::readID()
{
    return readRegister(REG_ID);
}

void ADS1299::dumpRegisters(Stream &port)
{
    uint8_t reg[24];

    readRegisters(0x00,24,reg);

    printDivider(port);

    port.println("ADS1299 REGISTER DUMP");

    printDivider(port);

    for(int i=0;i<24;i++)
    {
        port.print("0x");

        if(i<16)
            port.print("0");

        port.print(i,HEX);

        port.print("  ");

        port.print(ADS_RegisterNames[i]);

        while(port.getWriteError()==0 &&
              strlen(ADS_RegisterNames[i])<12)
            break;

        int pad = 12 - strlen(ADS_RegisterNames[i]);

        while(pad--)
            port.print(' ');

        port.print(" = 0x");

        if(reg[i]<16)
            port.print('0');

        port.print(reg[i],HEX);

        port.print("    ");

        port.println(byteToBinary(reg[i]));
    }

    printDivider(port);
}

bool ADS1299::verifyReadWrite(Stream &port)
{
    bool pass = true;

    uint8_t original = readRegister(REG_CONFIG1);

    uint8_t testValue;

    if(original==0x96)
        testValue=0x97;
    else
        testValue=0x96;

    writeRegister(REG_CONFIG1,testValue);

    uint8_t verify=readRegister(REG_CONFIG1);

    if(verify!=testValue)
    {
        port.println("CONFIG1 WRITE FAILED");
        pass=false;
    }

    writeRegister(REG_CONFIG1,original);

    verify=readRegister(REG_CONFIG1);

    if(verify!=original)
    {
        port.println("CONFIG1 RESTORE FAILED");
        pass=false;
    }

    return pass;
}

bool ADS1299::verifyRegisters(Stream &port)
{
    bool pass=true;

    uint8_t reg[24];

    readRegisters(0,24,reg);

    if(reg[0]==0x00)
    {
        port.println("ID register = 0x00");
        pass=false;
    }

    if(reg[0]==0xFF)
    {
        port.println("ID register = 0xFF");
        pass=false;
    }

    if(reg[1]==0x00)
    {
        port.println("CONFIG1 invalid");
        pass=false;
    }

    if(reg[1]==0xFF)
    {
        port.println("CONFIG1 floating");
        pass=false;
    }

    if(reg[5]==0x00)
    {
        port.println("CH1SET invalid");
        pass=false;
    }

    if(reg[5]==0xFF)
    {
        port.println("CH1SET floating");
        pass=false;
    }

    if(pass)
        port.println("REGISTER CHECK PASSED");
    else
        port.println("REGISTER CHECK FAILED");

    return pass;
}
