/**
 * integrating mediasoup server with a node.js application
 */

/* Please follow mediasoup installation requirements */
/* https://mediasoup.org/documentation/v3/mediasoup/installation/ */
import express from 'express'
const app = express()

import https from 'httpolyglot'
import fs from 'fs'
import path from 'path'
const __dirname = path.resolve()

import { Server } from 'socket.io'
import mediasoup, { getSupportedRtpCapabilities } from 'mediasoup'
import { createBrotliCompress } from 'zlib'

app.get('*', (req, res, next) => {
  const path = '/sfu/'
  if(req.path.indexOf(path) == 0 && req.path.length > path.length) return next()
  res.send('Hello from mediasoup app!')
})

app.use('/sfu/:room', express.static(path.join(__dirname, 'public')))

// SSL cert for HTTPS access
const options = {
  key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
  cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8')
}

const httpsServer = https.createServer(options, app)
httpsServer.listen(3000, () => {
  console.log('listening on port: ' + 3000)
})

const io = new Server(httpsServer)

// socket.io namespace (could represent a room?)
const connections = io.of('/mediasoup')

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer 
 **/
let worker
let rooms = {}
let peers = {}
let transports = []
let producers = []
let consumers = []
// let router
// let producerTransport
// let consumerTransport
// let producer
// let consumer

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  })
  console.log(`worker pid ${worker.pid}`)

  worker.on('died', error => {
    // This implies something serious happened, so kill the application
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
  })

  return worker
}

// We create a Worker as soon as our application starts
worker = createWorker()

// This is an Array of RtpCapabilities
// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// list of media codecs supported by mediasoup ...
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
]

connections.on('connection', async socket => {
  console.log(socket.id)
  socket.emit('connection-success', {
    socketId: socket.id,
  })

  socket.on('disconnect', () => {
    // do some cleanup
    console.log('peer disconnected')
  })

  socket.on('joinRoom', async ({roomName}, callback) => {
    //create router if it does not exist
    const router1 = await createRoom(roomName, socket.id)

    peers[socket.id] = {
      socket,
      roomName,
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: {
        name: '',
        isAdmin: false,
      }
    }

    const rtpCapabilities = router1.rtpCapabilities

    callback({ rtpCapabilities })
  })

  const createRoom = async (roomName, socketId) => {
    //worker createRouter(options)

    let router1
    let peers = []
    if(rooms[roomName]){
      router1 = rooms[roomName].router
      peers = rooms[roomName].peers || []

    }else {
      router1 =  await worker.createRouter({ mediaCodecs, })
    }

    console.log(`Router ID: ${router1.id}`, peers.length)

    rooms[roomName] = {
      router: router1,
      peers: [...peers, socketId],
    }

    return router1

  }

  // socket.on('createRoom', async (callback) => {
  //   if(router === undefined) {
  //     // worker.createRouter(options)
  //     // options = { mediaCodecs, appData }
  //     // mediaCodecs -> defined above
  //     // appData -> custom application data - we are not supplying any
  //     // none of the two are required
  //     router = await worker.createRouter({ mediaCodecs, })
  //     console.log(`Router ID: ${router.id}`)
  //   }

  //   getRtpCapabilities(callback)

  // })

  const getRtpCapabilities = (callback) => {
    const rtpCapabilities = router.rtpCapabilities

    callback({ rtpCapabilities })

  }


  // router = await worker.createRouter({ mediaCodecs, })

  // Client emits a request for RTP Capabilities
  // This event responds to the request
  // socket.on('getRtpCapabilities', (callback) => {

  //   const rtpCapabilities = router.rtpCapabilities

  //   console.log('rtp Capabilities', rtpCapabilities)

  //   // call callback from the client and send back the rtpCapabilities
  //   callback({ rtpCapabilities })
  // })

  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {

    const roomName = peers[socket.id].roomName

    const router = rooms[roomName].router

    createWebRtcTransport(callback).then(
      transport => {
        callback({
          params: {
            id:transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters
          }
        })

        // add transport to peers array
        addTransport(transport, roomName, consumer)

    }, error => {
      console.log(error)
    })
    // console.log(`Is this a sender request? ${sender}`)
    // The client indicates if it is a producer or a consumer
    // if sender is true, indicates a producer else a consumer
    // if (sender)
    //   producerTransport = await createWebRtcTransport(callback)
    // else
    //   consumerTransport = await createWebRtcTransport(callback)
  })

  const addTransport = (transport, roomName, consumer) => {
    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer }
    ]

    peers[socket.id] = {
      ...peers[socket.id],
      transports: [
        ...peers[socket.id].transports,
        transport.id,
      ]
    }
  }

  const addProducer = (producer, roomName) => {
    producers = [
      ...producers,
      { socketId: socket.id, producer, roomName,  }
    ]

    peers[socket.id] = {
      ...peers[socket.id],
      producers: [
        ...peers[socket.id].producers,
        producer.id
      ]
    }

  }

  socket.on('getProducers', callback => {
    const { roomName } = peers[socket.id]

    let producerList = []
    producers.forEach(producerData => {
      if(producerData.socketId !== socket.id & producerData.roomName === roomName) {
        producerList = [...producerList, producerData.producer.id]
      }
    })

    callback(producerList)

  })


  const getTransport = (socketId) => {
    const [ producerTransport ] = transports.filter(transport => transport.socketId === socketId && !transport.consumer)
    return producerTransport.transport
  }

  // see client's socket.emit('transport-connect', ...)
  socket.on('transport-connect', async ({ dtlsParameters }) => {
    console.log('DTLS PARAMS... ', { dtlsParameters })

    getTransport(socket.id).connect({dtlsParameters})
    // await producerTransport.connect({ dtlsParameters })
  })

  // see client's socket.emit('transport-produce', ...)
  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    // call produce based on the prameters from the client
    const producer = await getTransport(socket.id).produce({
      kind,
      rtpParameters,
    })

    const { roomName } = peers[socket.id]

    addProducer(producer, roomName)

    console.log('Producer ID: ', producer.id, producer.kind)


    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })

    // Send back to the client the Producer's id
    callback({
      id: producer.id,
      producersExist: producers.length>1 ? true : false
    })
  })

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on('transport-recv-connect', async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`)
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      // check if the router can consume the specified producer
      if (router.canConsume({
        producerId: producer.id,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
        })

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })

  socket.on('consumer-resume', async () => {
    console.log('consumer resume')
    await consumer.resume()
  })
})

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
  try {
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: '0.0.0.0', // replace with relevant IP address
          announcedIp: '127.0.0.1',
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    }

    // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
    let transport = await router.createWebRtcTransport(webRtcTransport_options)
    console.log(`transport id: ${transport.id}`)

    transport.on('dtlsstatechange', dtlsState => {
      if (dtlsState === 'closed') {
        transport.close()
      }
    })

    transport.on('close', () => {
      console.log('transport closed')
    })

    // send back to the client the following prameters
    // callback({
    //   // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
    //   params: {
    //     id: transport.id,
    //     iceParameters: transport.iceParameters,
    //     iceCandidates: transport.iceCandidates,
    //     dtlsParameters: transport.dtlsParameters,
    //   }
    // })

    resolve(transport)

  } catch (error) {
    reject(error)
    callback({
      params: {
        error: error
      }
    })
  }
})
}
