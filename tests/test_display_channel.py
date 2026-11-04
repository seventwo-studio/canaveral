import json
import socket
import unittest

from wsproto import ConnectionType, WSConnection
from wsproto.events import AcceptConnection, BytesMessage, Ping, Pong, Request, TextMessage

from canaveral.desktop_socket import DisplayChannel
from canaveral.model import Error


class DisplayChannelTests(unittest.TestCase):
    def setUp(self):
        self.client,self.server=socket.socketpair()
        self.addCleanup(self.client.close);self.addCleanup(self.server.close)
        self.client.settimeout(2);self.server.settimeout(2)
        self.consumer=WSConnection(ConnectionType.CLIENT);runner=WSConnection(ConnectionType.SERVER)
        runner.receive_data(self.consumer.send(Request(host='fixture',target='/display')))
        list(runner.events())
        self.consumer.receive_data(runner.send(AcceptConnection()));list(self.consumer.events())
        self.channel=DisplayChannel(self.server,runner)

    def test_control_and_binary_coalescing_fragmentation_and_ping(self):
        self.client.sendall(self.consumer.send(BytesMessage(data=b'first'))+
            self.consumer.send(TextMessage(data='{"type":"input-control",',message_finished=False))+
            self.consumer.send(TextMessage(data='"action":"take"}',message_finished=True))+
            self.consumer.send(Ping(payload=b'check')))
        self.assertEqual(self.channel.receive(1),b'first')
        self.assertEqual(self.channel.receive(1),{'type':'input-control','action':'take'})
        self.consumer.receive_data(self.client.recv(4096))
        self.assertEqual([e.payload for e in self.consumer.events() if isinstance(e,Pong)],[b'check'])
        self.channel.send_control({'type':'control','state':'owned'});self.channel.send_bytes(b'frame')
        messages=[]
        while len(messages)<2:
            self.consumer.receive_data(self.client.recv(4096));messages.extend(self.consumer.events())
        self.assertEqual(json.loads(messages[0].data),{'type':'control','state':'owned'})
        self.assertEqual(messages[1].data,b'frame')

    def test_oversized_fragments_are_rejected_before_completion(self):
        for index in range(16):
            self.client.sendall(self.consumer.send(BytesMessage(data=b'x'*4096,message_finished=False)))
            # A wire frame can need two socket reads because of its header.
            while len(self.channel.pending)<(index+1)*4096:
                self.channel.receive(.1)
        self.client.sendall(self.consumer.send(BytesMessage(data=b'x',message_finished=False)))
        with self.assertRaises(Error):
            for _ in range(30):self.channel.receive(.1)

    def test_control_must_be_json_object(self):
        self.client.sendall(self.consumer.send(TextMessage(data='[]')))
        with self.assertRaises(Error):self.channel.receive(1)


if __name__=='__main__':unittest.main()
