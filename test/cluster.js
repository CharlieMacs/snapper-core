'use strict'
/*global describe, it, before, after, beforeEach*/

// TODO some issue with script on redis cluster

const config = require('config')
const assert = require('assert')
const thunk = require('thunks')()
const ThunkQueue = require('thunk-queue')
const Producer = require('snapper-producer')

config.redis.hosts = [7000, 7001, 7002]

require('../app')
const redis = require('../services/redis')
const Consumer = require('./lib/consumer')

var producerId = 0

describe('snapper on redis cluster', function () {
  var producer = null
  var host = '127.0.0.1:' + config.port

  before(function *() {
    yield redis.client.flushall()
  })

  after(function *() {
    yield redis.client.flushall()
    yield thunk.delay(1000)
    process.emit('message', 'shutdown')
  })

  beforeEach(function (callback) {
    producer = new Producer(config.rpcPort, {
      secretKeys: config.tokenSecret,
      producerId: ++producerId + ''
    })
    producer
      .on('error', function (err) {
        console.error(err)
      })
      .once('connect', callback)
  })

  it('10000 messages, 200 rooms, 50 consumers', function *() {
    var consumers = []
    var messages = []
    var rooms = []
    while (messages.length < 10000) messages.push(messages.length)
    while (rooms.length < 200) rooms.push('room' + rooms.length)
    while (consumers.length < 50) {
      consumers.push(new Consumer(host, {
        path: '/websocket',
        token: producer.signAuth({userId: Consumer.genUserId()})
      }))
    }

    // 注册 consumers 消息处理器
    var thunkQueue = ThunkQueue()
    consumers.forEach(function (consumer, index) {
      var received = []
      thunkQueue.push(thunk(function (done) {
        consumer.message = function (message) {
          if (message === null) {
            // 不同的 room 不能保证时序
            received.sort(function (a, b) { return a - b })
            // if (JSON.stringify(received) !== JSON.stringify(messages)) console.log(JSON.stringify(received))
            assert.deepEqual(received, messages)
            done()
          } else {
            received.push(message)
          }
        }
        consumer.onerror = done
      }))
    })

    // 等待 consumers 连接并加入 chaos room
    yield consumers.map(function (consumer) {
      return thunk(function (done) {
        consumer.onopen = function () {
          thunk.all(rooms.map(function (room) {
            return producer.joinRoom(room, consumer.consumerId)
          }))(done)
        }
        consumer.connect()
      })
    })

    // 开始发送消息
    var _messages = messages.slice()
    var room = rooms[0]
    while (_messages.length) {
      let random = Math.ceil(Math.random() * 200)
      // 等待 random 毫秒
      yield thunk.delay(random)
      // 并发发送 random  条消息
      let todo = _messages.splice(0, random)
      room = rooms[random] || rooms[0]
      while (todo.length) producer.sendMessage(room, JSON.stringify(todo.shift()))
      process.stdout.write('.')
    }
    yield thunk.delay(1000)
    producer.sendMessage(room, JSON.stringify(null))

    // 等待 consumers 所有消息处理完毕
    yield thunkQueue.end()
  })
})
