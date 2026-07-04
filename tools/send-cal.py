import serial, time

# Open port carefully
ser = serial.Serial()
ser.port = 'COM3'
ser.baudrate = 115200
ser.timeout = 1
ser.write_timeout = 1
ser.dsrdtr = False
ser.rtscts = False

try:
    ser.open()
    print("Port opened")
    
    # Wait for boot to complete
    time.sleep(4)
    
    # Drain buffer
    ser.reset_input_buffer()
    
    # Send command
    ser.write(b'CAL:STATUS\n')
    ser.flush()
    print("Sent: CAL:STATUS")
    
    # Read response
    time.sleep(2)
    buf = b''
    deadline = time.time() + 3
    while time.time() < deadline:
        waiting = ser.in_waiting
        if waiting:
            chunk = ser.read(waiting)
            buf += chunk
            text = chunk.decode(errors='ignore')
            if 'kValue' in text or 'Commands' in text or 'Unknown' in text:
                print("GOT:", text.strip())
                break
        time.sleep(0.1)
    
    if buf:
        print("Full buffer:", buf.decode(errors='ignore')[-400:])
    else:
        print("No response received")
        
finally:
    ser.close()
    print("Done")
